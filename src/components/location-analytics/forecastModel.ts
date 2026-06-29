/**
 * Pure transform: 24-month QB history → a per-location forecast model for the
 * selected metric + horizon. Runs the Holt-Winters math and arranges actual /
 * estimate / future-projection values for the chart and table.
 *
 * Two kinds of months are held out of forecast training:
 *  - pre-opening months (before a location's openedMonth) — build-out costs.
 *  - the most recent `closeLag` completed months — not fully closed yet, so
 *    their expenses are understated (net income looks inflated). They are shown
 *    as a provisional "actual + estimate" cell, like the current partial month.
 */

import { forecastSeries, type ForecastMethod } from '@/lib/forecast/holtWinters';
import type { LocationForecastResponse, TrendMetric } from '@/types/location-analytics';

/**
 * How many of the most recent completed months are treated as "not yet closed"
 * for the expense-dependent metrics (gross profit, net income). Bump to 2 if the
 * monthly close runs longer. Revenue ignores this (it posts in real time).
 */
export const CLOSE_LAG_MONTHS: number = 2;

export interface ForecastLocation {
  qbLocation: string;
  label: string;
  state: string;
  connected: boolean;
  openedMonth: string | null; // months before this are pre-opening (excluded from the forecast)
  method: ForecastMethod;
  cmgr: number;
  actual: Record<string, number>; // all completed months (+ current partial month)
  est: Record<string, number>; // provisional months (last closeLag completed + current) → modeled estimate
  future: Record<string, number>; // future month → projected value
  connectValue: number; // last trained (non-provisional) completed actual — chart connector
  lastTrainMonth: string | null;
}

export interface ForecastModel {
  completedMonths: string[];
  currentMonthKey: string | null;
  provisionalMonths: string[]; // dual "actual + est" cells: last closeLag completed + current partial
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
  closeLag: number,
): ForecastModel {
  const currentMonthKey = data.currentMonthKey;
  const completedMonths = data.months.filter((m) => m !== currentMonthKey);

  // Most recent completed months treated as not-yet-closed (provisional).
  const provisionalCompleted = closeLag > 0 ? completedMonths.slice(-closeLag) : [];
  const provisionalSet = new Set(provisionalCompleted);
  // Ordered oldest→newest: provisional completed, then the current partial month.
  const provisionalMonths = currentMonthKey
    ? [...provisionalCompleted, currentMonthKey]
    : [...provisionalCompleted];

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

    // Train on completed months that are post-opening AND fully closed (not provisional).
    const trainingMonths = completedMonths.filter(
      (m) => (!s.openedMonth || m >= s.openedMonth) && !provisionalSet.has(m),
    );
    const history = trainingMonths.map((m) => histMap[m] ?? 0);
    const lastTrainMonth = trainingMonths[trainingMonths.length - 1] ?? null;

    // Forecast covers: each provisional month, then each future month.
    const steps = provisionalMonths.length + horizon;
    const { method, forecast, cmgr } = forecastSeries(history, steps);

    const actual: Record<string, number> = {};
    completedMonths.forEach((m) => {
      actual[m] = histMap[m] ?? 0;
    });
    if (currentMonthKey) actual[currentMonthKey] = histMap[currentMonthKey] ?? 0;

    const est: Record<string, number> = {};
    provisionalMonths.forEach((m, i) => {
      est[m] = forecast[i] ?? 0;
    });
    const future: Record<string, number> = {};
    futureMonths.forEach((m, i) => {
      future[m] = forecast[provisionalMonths.length + i] ?? 0;
    });

    return {
      qbLocation: s.qbLocation,
      label: s.label,
      state: s.state,
      connected: s.connected,
      openedMonth: s.openedMonth,
      method,
      cmgr,
      actual,
      est,
      future,
      connectValue: lastTrainMonth ? (histMap[lastTrainMonth] ?? 0) : 0,
      lastTrainMonth,
    };
  });

  return { completedMonths, currentMonthKey, provisionalMonths, futureMonths, allMonths, locations };
}
