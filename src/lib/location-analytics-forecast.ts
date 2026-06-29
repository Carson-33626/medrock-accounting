/**
 * Location Analytics — 24-month QB P&L history for the Forecast tab.
 *
 * Pulls monthly P&L per location in ONE QB call each (summarize_column_by=Month)
 * and returns a dense monthly history (24 completed months + the current partial
 * month). The Holt-Winters projection runs client-side on this history.
 *
 * Read-only. See docs/superpowers/specs/2026-06-29-location-analytics-forecast-design.md
 */

import { getMonthlyProfitAndLoss, getConnectedLocations, type Location } from './quickbooks-multi';
import { LOCATIONS, round2 } from './location-analytics';
import type {
  Basis,
  LocationForecastPoint,
  LocationForecastResponse,
  LocationForecastSeries,
} from '@/types/location-analytics';

const HISTORY_MONTHS = 24;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Inclusive ordered 'YYYY-MM' list from startMonth..endMonth. */
function buildMonths(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  let [year, month] = startMonth.split('-').map(Number);
  const [endYear, endMonthNum] = endMonth.split('-').map(Number);
  while (year < endYear || (year === endYear && month <= endMonthNum)) {
    months.push(`${year}-${pad2(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** Subtract n months from a 'YYYY-MM' key. */
function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const zero = year * 12 + (m - 1) + delta;
  return `${Math.floor(zero / 12)}-${pad2((zero % 12) + 1)}`;
}

export async function computeLocationForecast(opts: {
  basis: Basis;
  /** Today's date (YYYY-MM-DD); injected for testability. */
  today: string;
}): Promise<LocationForecastResponse> {
  const { basis, today } = opts;
  const currentMonth = today.slice(0, 7);
  const lastCompleted = shiftMonth(currentMonth, -1);
  const startMonth = shiftMonth(lastCompleted, -(HISTORY_MONTHS - 1));

  const months = buildMonths(startMonth, currentMonth); // 24 completed + current partial
  const startDate = `${startMonth}-01`;
  const endDate = today;

  const connected = new Set<Location>(await getConnectedLocations());

  const series: LocationForecastSeries[] = [];
  for (const loc of LOCATIONS) {
    const isConnected = connected.has(loc.qb);
    const byMonth = new Map<string, { revenue: number; cogs: number; grossProfit: number; netIncome: number }>();
    if (isConnected) {
      try {
        const rows = await getMonthlyProfitAndLoss({
          location: loc.qb,
          startDate,
          endDate,
          accounting_method: basis,
        });
        for (const r of rows) {
          byMonth.set(r.month, {
            revenue: round2(r.revenue),
            cogs: round2(r.cogs),
            grossProfit: round2(r.grossProfit),
            netIncome: round2(r.netIncome),
          });
        }
      } catch (error) {
        console.error(`[Location Forecast] QB monthly fetch failed for ${loc.qb}:`, error);
      }
    }

    const points: LocationForecastPoint[] = months.map((month) => {
      const v = byMonth.get(month);
      return {
        month,
        revenue: v?.revenue ?? 0,
        cogs: v?.cogs ?? 0,
        grossProfit: v?.grossProfit ?? 0,
        netIncome: v?.netIncome ?? 0,
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
    basis,
    months,
    currentMonthKey: currentMonth,
    series,
    generatedAt: new Date().toISOString(),
  };
}
