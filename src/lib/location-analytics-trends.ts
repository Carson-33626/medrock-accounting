/**
 * Location Analytics — monthly trend series (over-time charts).
 *
 * Builds a dense per-month, per-location series of QB P&L (revenue / COGS /
 * gross profit / net income) cross-checked against RDS monthly LifeFile sales
 * and FIFO COGS. Powers the "Trends & Charts" tab.
 *
 * Read-only: pulls and compares, never writes. Lazy-loaded by its own route so
 * the (slow) per-month QB calls don't affect the fast Summary aggregate.
 * See docs/superpowers/specs/2026-06-29-location-analytics-trends-charts-design.md
 */

import { getRdsPool } from './rds';
import { getCompanyFinancials, getConnectedLocations, type Location } from './quickbooks-multi';
import { LOCATIONS, RDS_NAMES, round2 } from './location-analytics';
import type {
  Basis,
  LocationTrendPoint,
  LocationTrendSeries,
  LocationTrendsResponse,
} from '@/types/location-analytics';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ~250ms spacing between QB calls to respect rate limits (matches getRevenueByPeriod). */
const QB_CALL_SPACING_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Inclusive ordered list of 'YYYY-MM' months from startMonth..endMonth. */
function buildMonths(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  let [year, month] = startMonth.split('-').map(Number); // month is 1-based
  const [endYear, endMonthNum] = endMonth.split('-').map(Number);
  while (year < endYear || (year === endYear && month <= endMonthNum)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** Calendar-month bounds (first day / last day) for a 'YYYY-MM' key, as YYYY-MM-DD. */
function monthBounds(month: string): { start: string; end: string } {
  const [year, m] = month.split('-').map(Number);
  const lastDay = new Date(year, m, 0).getDate(); // day 0 of next month = last day of this one
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** Σ Subtotal by location AND month over the date range (all ship-to states). */
async function fetchMonthlyLifefileSales(
  startDate: string,
  endDate: string,
): Promise<Map<string, number>> {
  const res = await getRdsPool().query<{ location: string; month: string; sales: string }>(
    `SELECT row_data->>'Location' AS location,
            to_char(to_date(row_data->>'Tx Effective Date', 'MM/DD/YYYY'), 'YYYY-MM') AS month,
            COALESCE(SUM(NULLIF(regexp_replace(row_data->>'Subtotal', '[^0-9.\\-]', '', 'g'), '')::numeric), 0) AS sales
     FROM source.sales_tax_report
     WHERE row_data->>'Location' = ANY($1)
       AND to_date(row_data->>'Tx Effective Date', 'MM/DD/YYYY') BETWEEN $2 AND $3
     GROUP BY 1, 2`,
    [RDS_NAMES, startDate, endDate],
  );
  const m = new Map<string, number>();
  for (const r of res.rows) m.set(`${r.location}|${r.month}`, round2(parseFloat(r.sales)));
  return m;
}

/** Σ consumed_value_in_month by location AND month over the month range (FIFO COGS). */
async function fetchMonthlyFifoCogs(
  fifoBasis: string,
  startMonth: string,
  endMonth: string,
): Promise<Map<string, number>> {
  const res = await getRdsPool().query<{ location: string; month: string; cogs: string }>(
    `SELECT location, as_of_month AS month, COALESCE(SUM(consumed_value_in_month), 0)::float8 AS cogs
     FROM inventory.fifo_valuation_summary
     WHERE basis = $1 AND location = ANY($2) AND as_of_month BETWEEN $3 AND $4
     GROUP BY location, as_of_month`,
    [fifoBasis, RDS_NAMES, startMonth, endMonth],
  );
  const m = new Map<string, number>();
  for (const r of res.rows) m.set(`${r.location}|${r.month}`, round2(parseFloat(r.cogs)));
  return m;
}

async function fetchHasCashBasis(): Promise<boolean> {
  const res = await getRdsPool().query<{ has_cash: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM inventory.fifo_valuation_summary WHERE basis = 'cash') AS has_cash`,
  );
  return res.rows[0]?.has_cash ?? false;
}

/** Per-month QB P&L for one location; failures degrade that month's QB figures to 0. */
async function fetchQbMonthly(
  location: Location,
  basis: Basis,
  months: string[],
): Promise<Map<string, { revenue: number; cogs: number; grossProfit: number; netIncome: number }>> {
  const out = new Map<
    string,
    { revenue: number; cogs: number; grossProfit: number; netIncome: number }
  >();
  for (const month of months) {
    const { start, end } = monthBounds(month);
    try {
      const f = await getCompanyFinancials({
        location,
        startDate: start,
        endDate: end,
        accounting_method: basis,
      });
      out.set(month, {
        revenue: round2(f.revenue),
        cogs: round2(f.cogs),
        grossProfit: round2(f.gross_profit),
        netIncome: round2(f.net_income),
      });
    } catch (error) {
      console.error(`[Location Trends] QB fetch failed for ${location} ${month}:`, error);
      out.set(month, { revenue: 0, cogs: 0, grossProfit: 0, netIncome: 0 });
    }
    await sleep(QB_CALL_SPACING_MS);
  }
  return out;
}

export async function computeLocationTrends(opts: {
  startDate: string;
  endDate: string;
  basis: Basis;
}): Promise<LocationTrendsResponse> {
  const { startDate, endDate, basis } = opts;
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new Error('Invalid date (expected YYYY-MM-DD)');
  }
  const fifoBasis = basis === 'Cash' ? 'cash' : 'accrual';
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);
  const months = buildMonths(startMonth, endMonth);

  // RDS (fast, parallel) + basis availability.
  const [salesMap, hasCash] = await Promise.all([
    fetchMonthlyLifefileSales(startDate, endDate),
    fetchHasCashBasis(),
  ]);
  const fifoAvailable = fifoBasis === 'accrual' || hasCash;
  const cogsMap = fifoAvailable
    ? await fetchMonthlyFifoCogs(fifoBasis, startMonth, endMonth)
    : new Map<string, number>();

  const connected = new Set<Location>(await getConnectedLocations());

  // QB per connected location, sequentially (rate limits).
  const series: LocationTrendSeries[] = [];
  for (const loc of LOCATIONS) {
    const isConnected = connected.has(loc.qb);
    const qbMonthly = isConnected ? await fetchQbMonthly(loc.qb, basis, months) : null;

    const points: LocationTrendPoint[] = months.map((month) => {
      const qb = qbMonthly?.get(month) ?? { revenue: 0, cogs: 0, grossProfit: 0, netIncome: 0 };
      return {
        month,
        revenue: qb.revenue,
        cogs: qb.cogs,
        grossProfit: qb.grossProfit,
        netIncome: qb.netIncome,
        lifefileSales: salesMap.get(`${loc.rds}|${month}`) ?? 0,
        fifoCogs: fifoAvailable ? (cogsMap.get(`${loc.rds}|${month}`) ?? 0) : null,
      };
    });

    series.push({
      qbLocation: loc.qb,
      label: loc.label,
      state: loc.state,
      connected: isConnected,
      points,
    });
  }

  return {
    startDate,
    endDate,
    basis,
    months,
    series,
    fifoBasisAvailable: fifoAvailable,
    generatedAt: new Date().toISOString(),
  };
}
