/**
 * Pure transform: 24-month QB history → a per-location forecast model for the
 * selected metric + horizon. Runs the Holt-Winters math and arranges actual /
 * current-month-estimate / future-projection values for the chart and table.
 */

import { forecastSeries, type ForecastMethod } from '@/lib/forecast/holtWinters';
import type { LocationForecastResponse, TrendMetric } from '@/types/location-analytics';

export interface ForecastLocation {
  qbLocation: string;
  label: string;
  state: string;
  connected: boolean;
  method: ForecastMethod;
  cmgr: number;
  actual: Record<string, number>; // completed months (+ current partial month)
  estCurrent: number | null; // full-month estimate for the current partial month
  future: Record<string, number>; // future month → projected value
  connectValue: number; // last completed actual (chart connector)
  lastCompletedMonth: string | null;
}

export interface ForecastModel {
  completedMonths: string[];
  currentMonthKey: string | null;
  futureMonths: string[];
  allMonths: string[]; // history (incl. current) + future
  locations: ForecastLocation[];
}

function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const zero = year * 12 + (m - 1) + delta;
  return `${Math.floor(zero / 12)}-${String((zero % 12) + 1).padStart(2, '0')}`;
}

export function buildForecastModel(
  data: LocationForecastResponse,
  metric: TrendMetric,
  horizon: number,
): ForecastModel {
  const currentMonthKey = data.currentMonthKey;
  const completedMonths = data.months.filter((m) => m !== currentMonthKey);
  const lastCompletedMonth = completedMonths[completedMonths.length - 1] ?? null;

  const futureMonths: string[] = [];
  if (currentMonthKey) {
    for (let i = 1; i <= horizon; i++) futureMonths.push(shiftMonth(currentMonthKey, i));
  }
  const allMonths = [...data.months, ...futureMonths];

  const locations: ForecastLocation[] = data.series.map((s) => {
    const histMap: Record<string, number> = {};
    s.points.forEach((p) => {
      histMap[p.month] = p[metric];
    });

    const history = completedMonths.map((m) => histMap[m] ?? 0);
    // horizon + 1 steps: step 0 = current partial month estimate, steps 1..horizon = future.
    const { method, forecast, cmgr } = forecastSeries(history, horizon + 1);

    const actual: Record<string, number> = {};
    completedMonths.forEach((m) => {
      actual[m] = histMap[m] ?? 0;
    });
    if (currentMonthKey) actual[currentMonthKey] = histMap[currentMonthKey] ?? 0;

    const estCurrent = forecast.length > 0 ? forecast[0] : null;
    const future: Record<string, number> = {};
    futureMonths.forEach((m, i) => {
      future[m] = forecast[i + 1] ?? 0;
    });

    return {
      qbLocation: s.qbLocation,
      label: s.label,
      state: s.state,
      connected: s.connected,
      method,
      cmgr,
      actual,
      estCurrent,
      future,
      connectValue: lastCompletedMonth ? (histMap[lastCompletedMonth] ?? 0) : 0,
      lastCompletedMonth,
    };
  });

  return { completedMonths, currentMonthKey, futureMonths, allMonths, locations };
}
