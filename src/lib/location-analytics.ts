/**
 * Location Analytics compute — QuickBooks P&L per location (backbone) cross-checked
 * against RDS operational data (LifeFile dispensing sales + FIFO COGS / on-hand).
 *
 * Read-only: pulls and compares, never writes. See
 * docs/superpowers/specs/2026-06-15-location-analytics-modernization-design.md
 */

import { getRdsPool } from './rds';
import { getCompanyFinancials, getConnectedLocations, type Location } from './quickbooks-multi';
import type {
  Basis,
  LocationAnalyticsResponse,
  LocationAnalyticsRow,
  LocationAnalyticsTotals,
  QbPnl,
  RdsMetrics,
  Reconciliation,
} from '@/types/location-analytics';

interface LocationConfig {
  qb: Location; // QuickBooks company name
  rds: string; // source.sales_tax_report / fifo_valuation_summary location string
  state: string;
  label: string;
}

/** Canonical mapping: QB and RDS name the same three locations differently. */
const LOCATIONS: readonly LocationConfig[] = [
  { qb: 'MedRock FL', rds: 'MedRock Florida', state: 'FL', label: 'Florida' },
  { qb: 'MedRock TN', rds: 'MedRock Tennessee', state: 'TN', label: 'Tennessee' },
  { qb: 'MedRock TX', rds: 'MedRock Texas', state: 'TX', label: 'Texas' },
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_THRESHOLD = 5;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Signed percentage of `part` relative to `whole` (0 when whole is 0). */
function pct(part: number, whole: number): number {
  return whole !== 0 ? round2((part / whole) * 100) : 0;
}

const RDS_NAMES: string[] = LOCATIONS.map((l) => l.rds);

/** Σ Subtotal by location over the date range — all ship-to states (full dispensing revenue). */
async function fetchLifefileSales(startDate: string, endDate: string): Promise<Map<string, number>> {
  const res = await getRdsPool().query<{ location: string; sales: string }>(
    `SELECT row_data->>'Location' AS location,
            COALESCE(SUM(NULLIF(regexp_replace(row_data->>'Subtotal', '[^0-9.\\-]', '', 'g'), '')::numeric), 0) AS sales
     FROM source.sales_tax_report
     WHERE row_data->>'Location' = ANY($1)
       AND to_date(row_data->>'Tx Effective Date', 'MM/DD/YYYY') BETWEEN $2 AND $3
     GROUP BY 1`,
    [RDS_NAMES, startDate, endDate],
  );
  const m = new Map<string, number>();
  for (const r of res.rows) m.set(r.location, round2(parseFloat(r.sales)));
  return m;
}

/** Σ consumed_value_in_month by location over the month range (FIFO COGS). */
async function fetchFifoCogs(
  fifoBasis: string,
  startMonth: string,
  endMonth: string,
): Promise<Map<string, number>> {
  const res = await getRdsPool().query<{ location: string; cogs: string }>(
    `SELECT location, COALESCE(SUM(consumed_value_in_month), 0)::float8 AS cogs
     FROM inventory.fifo_valuation_summary
     WHERE basis = $1 AND location = ANY($2) AND as_of_month BETWEEN $3 AND $4
     GROUP BY location`,
    [fifoBasis, RDS_NAMES, startMonth, endMonth],
  );
  const m = new Map<string, number>();
  for (const r of res.rows) m.set(r.location, round2(parseFloat(r.cogs)));
  return m;
}

/** On-hand FIFO value at the latest month <= endMonth, summed across categories, by location. */
async function fetchFifoOnHand(fifoBasis: string, endMonth: string): Promise<Map<string, number>> {
  const res = await getRdsPool().query<{ location: string; on_hand: string }>(
    `SELECT f.location, COALESCE(SUM(f.on_hand_value_fifo), 0)::float8 AS on_hand
     FROM inventory.fifo_valuation_summary f
     WHERE f.basis = $1 AND f.location = ANY($2)
       AND f.as_of_month = (
         SELECT MAX(g.as_of_month) FROM inventory.fifo_valuation_summary g
         WHERE g.basis = $1 AND g.location = f.location AND g.as_of_month <= $3
       )
     GROUP BY f.location`,
    [fifoBasis, RDS_NAMES, endMonth],
  );
  const m = new Map<string, number>();
  for (const r of res.rows) m.set(r.location, round2(parseFloat(r.on_hand)));
  return m;
}

async function fetchHasCashBasis(): Promise<boolean> {
  const res = await getRdsPool().query<{ has_cash: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM inventory.fifo_valuation_summary WHERE basis = 'cash') AS has_cash`,
  );
  return res.rows[0]?.has_cash ?? false;
}

async function fetchFeedAsOf(): Promise<string | null> {
  const res = await getRdsPool().query<{ as_of: string | null }>(
    `SELECT max(ingested_at)::text AS as_of FROM source.sales_tax_report`,
  );
  return res.rows[0]?.as_of ?? null;
}

function buildReconciliation(
  qb: QbPnl | null,
  rds: RdsMetrics,
  threshold: number,
): Reconciliation | null {
  if (!qb) return null;
  const revenueVariance = round2(qb.revenue - rds.lifefileSales);
  const revenueVariancePercent = pct(revenueVariance, qb.revenue);
  const revenueFlagged = Math.abs(revenueVariancePercent) > threshold;

  let cogsVariance: number | null = null;
  let cogsVariancePercent: number | null = null;
  let cogsFlagged = false;
  if (rds.fifoCogs !== null) {
    cogsVariance = round2(qb.cogs - rds.fifoCogs);
    cogsVariancePercent = pct(cogsVariance, qb.cogs);
    cogsFlagged = Math.abs(cogsVariancePercent) > threshold;
  }

  return {
    revenueVariance,
    revenueVariancePercent,
    revenueFlagged,
    cogsVariance,
    cogsVariancePercent,
    cogsFlagged,
  };
}

function buildTotals(rows: LocationAnalyticsRow[], fifoAvailable: boolean): LocationAnalyticsTotals {
  let revenue = 0;
  let cogs = 0;
  let grossProfit = 0;
  let payrollTotal = 0;
  let operatingExpensesTotal = 0;
  let netIncome = 0;
  let lifefileSales = 0;
  let fifoCogs: number | null = fifoAvailable ? 0 : null;
  let onHandInventory: number | null = fifoAvailable ? 0 : null;

  for (const r of rows) {
    if (r.qb) {
      revenue += r.qb.revenue;
      cogs += r.qb.cogs;
      grossProfit += r.qb.grossProfit;
      payrollTotal += r.qb.payrollTotal;
      operatingExpensesTotal += r.qb.operatingExpensesTotal;
      netIncome += r.qb.netIncome;
    }
    lifefileSales += r.rds.lifefileSales;
    if (fifoCogs !== null && r.rds.fifoCogs !== null) fifoCogs += r.rds.fifoCogs;
    if (onHandInventory !== null && r.rds.onHandInventory !== null) {
      onHandInventory += r.rds.onHandInventory;
    }
  }

  return {
    revenue: round2(revenue),
    cogs: round2(cogs),
    grossProfit: round2(grossProfit),
    grossMarginPercent: pct(grossProfit, revenue),
    payrollTotal: round2(payrollTotal),
    operatingExpensesTotal: round2(operatingExpensesTotal),
    netIncome: round2(netIncome),
    netMarginPercent: pct(netIncome, revenue),
    lifefileSales: round2(lifefileSales),
    fifoCogs: fifoCogs === null ? null : round2(fifoCogs),
    onHandInventory: onHandInventory === null ? null : round2(onHandInventory),
  };
}

export async function computeLocationAnalytics(opts: {
  startDate: string;
  endDate: string;
  basis: Basis;
  thresholdPercent: number;
}): Promise<LocationAnalyticsResponse> {
  const { startDate, endDate, basis } = opts;
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new Error('Invalid date (expected YYYY-MM-DD)');
  }
  const threshold = Number.isFinite(opts.thresholdPercent)
    ? Math.max(0, opts.thresholdPercent)
    : DEFAULT_THRESHOLD;
  const fifoBasis = basis === 'Cash' ? 'cash' : 'accrual';
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);

  // RDS sales + freshness + cash-availability up front (independent of QB).
  const [sales, hasCash, feedAsOf] = await Promise.all([
    fetchLifefileSales(startDate, endDate),
    fetchHasCashBasis(),
    fetchFeedAsOf(),
  ]);
  const fifoAvailable = fifoBasis === 'accrual' || hasCash;
  const [cogsMap, onHandMap] = fifoAvailable
    ? await Promise.all([
        fetchFifoCogs(fifoBasis, startMonth, endMonth),
        fetchFifoOnHand(fifoBasis, endMonth),
      ])
    : [new Map<string, number>(), new Map<string, number>()];

  const connected = new Set<Location>(await getConnectedLocations());

  // QB fetched sequentially per location to respect rate limits (per existing lib).
  const rows: LocationAnalyticsRow[] = [];
  for (const loc of LOCATIONS) {
    const isConnected = connected.has(loc.qb);
    let qb: QbPnl | null = null;
    if (isConnected) {
      try {
        const f = await getCompanyFinancials({
          location: loc.qb,
          startDate,
          endDate,
          accounting_method: basis,
        });
        qb = {
          revenue: round2(f.revenue),
          cogs: round2(f.cogs),
          grossProfit: round2(f.gross_profit),
          grossMarginPercent: round2(f.gross_margin_percent),
          payrollTotal: round2(f.payroll_total),
          operatingExpensesTotal: round2(f.operating_expenses_total),
          netIncome: round2(f.net_income),
          netMarginPercent: round2(f.net_margin_percent),
        };
      } catch (error) {
        console.error(`[Location Analytics] QB fetch failed for ${loc.qb}:`, error);
        qb = null;
      }
    }

    const rds: RdsMetrics = {
      lifefileSales: round2(sales.get(loc.rds) ?? 0),
      fifoCogs: fifoAvailable ? round2(cogsMap.get(loc.rds) ?? 0) : null,
      onHandInventory: fifoAvailable ? round2(onHandMap.get(loc.rds) ?? 0) : null,
      fifoBasisAvailable: fifoAvailable,
    };

    rows.push({
      qbLocation: loc.qb,
      label: loc.label,
      state: loc.state,
      connected: isConnected,
      qb,
      rds,
      reconciliation: buildReconciliation(qb, rds, threshold),
    });
  }

  return {
    startDate,
    endDate,
    basis,
    varianceThresholdPercent: threshold,
    locations: rows,
    totals: buildTotals(rows, fifoAvailable),
    feedAsOf,
    generatedAt: new Date().toISOString(),
  };
}
