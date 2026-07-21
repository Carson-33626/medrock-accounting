/**
 * Adapter: 24-month QB history (+ optional current partial month) → a
 * per-location forecast model for the selected metric + horizon, on top of
 * the sortKey/count forecast engine (`@/lib/forecast/engine`).
 *
 * This is the seam that keeps the existing string-month ('YYYY-MM') chart/table
 * working on top of the engine, which speaks numeric sortKeys internally. It:
 *  1. Converts each location's `LocationForecastSeries` for the selected metric
 *     into a `DataPoint[]` (sortKey = year*100+month, count = point[metric]),
 *     dropping pre-opening months (month < openedMonth).
 *  2. Runs `buildForecastResult` (engine) to get history + projection per
 *     location, and `buildScores` (backtest) to get per-(entity, method) WAPE
 *     scores — the engine itself always returns `scores: []` to avoid an
 *     engine <-> backtest import cycle, so the adapter computes them.
 *  3. Maps the result back onto `ForecastModel`/`ForecastLocation`: completed
 *     (actual) months, hold-out + current-partial (est) months, and
 *     strictly-future (future) months, keyed by 'YYYY-MM' string.
 */

import {
  buildForecastResult, skToYm, currentMonthKey as cmkFromDate,
} from '@/lib/forecast/engine';
import { buildScores } from '@/lib/forecast/backtest';
import type {
  DataPoint, EntityMethodScore, MethodSelection,
} from '@/lib/forecast/types';
import { FETCH_METHOD_FOR_NONE } from '@/lib/forecast/types';
import type { LocationForecastResponse, TrendMetric } from '@/types/location-analytics';

export interface ForecastLocation {
  qbLocation: string;
  label: string;
  state: string;
  connected: boolean;
  openedMonth: string | null;
  method: string;                    // resolved engine label (may include "→ fallback")
  cmgr: number;
  actual: Record<string, number>;    // completed months (< current), YYYY-MM → value
  est: Record<string, number>;       // hold-out + current-partial months → modeled estimate
  future: Record<string, number>;    // future months → projection
  connectValue: number;              // value at the anchor/last-complete month (chart connector)
  lastTrainMonth: string | null;     // the anchor month (YYYY-MM)
}

export interface ForecastModel {
  completedMonths: string[];
  currentMonthKey: string | null;
  provisionalMonths: string[];       // hold-out months + current partial (dual actual+est cells)
  futureMonths: string[];
  allMonths: string[];
  locations: ForecastLocation[];
  scores: EntityMethodScore[];
  anchorMonth: string;               // YYYY-MM
  showProjection: boolean;           // false when method = 'none'
}

function ymToSortKey(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return y * 100 + m;
}
function sortKeyToYm(sk: number): string {
  const { y, m } = skToYm(sk);
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function buildForecastModel(
  data: LocationForecastResponse,
  metric: TrendMetric,
  horizon: number,
  method: MethodSelection,
  anchorMonth?: string,
): ForecastModel {
  const now = new Date(`${data.currentMonthKey ?? data.months[data.months.length - 1]}-15T00:00:00`);
  const cmk = cmkFromDate(now);

  // Build the engine input: one DataPoint[] per location, pre-opening months dropped.
  const seriesMap = new Map<string, DataPoint[]>();
  for (const s of data.series) {
    const pts: DataPoint[] = [];
    for (const p of s.points) {
      if (s.openedMonth && p.month < s.openedMonth) continue;
      pts.push({ label: p.month, sortKey: ymToSortKey(p.month), count: p[metric], isProjected: false });
    }
    pts.sort((a, b) => a.sortKey - b.sortKey);
    if (pts.length) seriesMap.set(s.qbLocation, pts);
  }

  const engineMethod = method === 'none' ? FETCH_METHOD_FOR_NONE : method;
  const anchorKey = anchorMonth ? ymToSortKey(anchorMonth) : undefined;
  const result = buildForecastResult(seriesMap, horizon, engineMethod, now, anchorKey);

  const anchorSk = result.anchorKey;
  // The engine deliberately returns scores: [] (avoids an engine<->backtest import
  // cycle) — the adapter computes them itself.
  const scores = buildScores(seriesMap, result.anchorKey, cmk);
  const byLoc = new Map(result.entities.map((e) => [e.entity, e]));

  const locations: ForecastLocation[] = data.series.map((s) => {
    const ef = byLoc.get(s.qbLocation);
    const actual: Record<string, number> = {};
    const est: Record<string, number> = {};
    const future: Record<string, number> = {};
    let connectValue = 0;
    if (ef) {
      for (const p of ef.historical) {
        actual[p.label] = p.count;
        if (p.sortKey === anchorSk) connectValue = p.count;
      }
      for (const p of ef.projected) {
        // Authoritative split: anchor < sk < currentMonth -> hold-out (est);
        // sk >= currentMonth -> strictly-future (future).
        if (anchorSk < p.sortKey && p.sortKey < cmk) est[p.label] = p.count;
        else if (p.sortKey >= cmk) future[p.label] = p.count;
      }
    }
    return {
      qbLocation: s.qbLocation,
      label: s.label,
      state: s.state,
      connected: s.connected,
      openedMonth: s.openedMonth,
      method: ef?.forecastMethod ?? 'n/a',
      cmgr: ef?.cmgr ?? 0,
      actual, est, future,
      connectValue,
      lastTrainMonth: sortKeyToYm(anchorSk),
    };
  });

  // Month axis: union of every location's historical + projected keys, ascending.
  const keySet = new Set<number>();
  for (const e of result.entities) {
    for (const p of e.historical) keySet.add(p.sortKey);
    for (const p of e.projected) keySet.add(p.sortKey);
  }
  const allSk = [...keySet].sort((a, b) => a - b);
  const allMonths = allSk.map(sortKeyToYm);
  const completedMonths = allSk.filter((k) => k < cmk).map(sortKeyToYm);
  const futureMonths = allSk.filter((k) => k >= cmk).map(sortKeyToYm);
  const provisionalMonths = allSk.filter((k) => anchorSk < k && k < cmk).map(sortKeyToYm);
  const currentKey = data.currentMonthKey;
  if (currentKey && !provisionalMonths.includes(currentKey) && keySet.has(ymToSortKey(currentKey))) {
    provisionalMonths.push(currentKey);
  }

  return {
    completedMonths,
    currentMonthKey: currentKey,
    provisionalMonths,
    futureMonths,
    allMonths,
    locations,
    scores,
    anchorMonth: sortKeyToYm(anchorSk),
    showProjection: method !== 'none',
  };
}
