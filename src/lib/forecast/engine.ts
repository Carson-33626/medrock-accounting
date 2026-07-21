// Ported from MRPBI power_bi_replacement_be/src/forecast/forecast.engine.ts.
// Adaptations for the dollar (net income) domain, per task-2-brief.md:
//  - Tiering removed entirely (NEW_CEILING, RISING_CEILING, classifyTier, RISING params gone).
//    A single MATURE Holt-Winters param set is used regardless of history/level.
//  - fmtMonth now emits 'YYYY-MM' labels instead of MRPBI's "Mar '26".
//  - proj() no longer clamps at zero — net income can be negative and must flow through.
//  - EntityForecast.totalValue (was totalCount); no `tier` field.
//  - buildForecastResult does NOT import buildScores from ./backtest (would create an
//    engine↔backtest import cycle); scores attached by the adapter via buildScores
//    (avoids engine↔backtest cycle).
import { DataPoint, EngineForecastResult, EntityForecast, ForecastMethod, MethodOutput, MonthLabel } from './types';

export function fmtMonth(m: number, y: number): string {
  return `${y}-${String(m).padStart(2, '0')}`;
}
export function skToYm(sortKey: number): { y: number; m: number } {
  return { y: Math.floor(sortKey / 100), m: sortKey % 100 };
}
export function currentMonthKey(now: Date): number {
  return now.getFullYear() * 100 + (now.getMonth() + 1);
}

/**
 * Fraction of the entity's current (last-complete-month) level below which a
 * leading run of months is treated as pre-launch ramp-up and dropped.
 *
 * A location that opened mid-history (e.g. MedRock TX went live 2026-02) carries
 * a long tail of single/double-digit months beforehand. Left in, those months
 * (a) drag the seasonal-index buckets for their calendar months down to ~1% of
 * the grand average, which then collapses the deseasonalized projection toward
 * zero, and (b) draw a flat near-zero line across the chart before the real
 * ramp. Trimming the leading sub-threshold prefix fixes both.
 */
export const LAUNCH_FRACTION = 0.10;

/**
 * Drop the leading contiguous run of months whose volume is below
 * LAUNCH_FRACTION × currentLevel (the pre-launch ramp). Only the leading prefix
 * is trimmed — once volume first reaches the threshold everything after is kept,
 * even a later slow month. Never trims when the first month already qualifies,
 * and never returns fewer than the tail from the launch month onward.
 */
export function trimLeadingRampUp(series: DataPoint[], currentLevel: number): DataPoint[] {
  if (series.length <= 2 || currentLevel <= 0) return series;
  const threshold = currentLevel * LAUNCH_FRACTION;
  let launchIdx = 0;
  while (launchIdx < series.length && series[launchIdx].count < threshold) launchIdx++;
  if (launchIdx <= 0 || launchIdx >= series.length) return series;
  return series.slice(launchIdx);
}

// phi = 1.0 → undamped (linear) trend. Damping (phi < 1) systematically UNDER-projected a
// business in sustained growth: a live backtest showed damped phi=0.90 running ~18% low vs
// actuals across every anchor, while phi=1.0 cut that drift to ~3% and improved WAPE by a third
// (see docs/superpowers/specs/2026-07-17-...-backtest-anchor + the P3 discussion). Trade-off:
// undamped carries the trend indefinitely, so a hard growth reversal would overshoot.
const MATURE = { alpha: 0.15, beta: 0.02, gamma: 0.20, phi: 1.0 };

function nextMonthKey(sortKey: number, h: number): { sortKey: number; label: string } {
  const { y, m } = skToYm(sortKey);
  const d = new Date(y, m - 1 + h, 1);
  const ny = d.getFullYear(), nm = d.getMonth() + 1;
  return { sortKey: ny * 100 + nm, label: fmtMonth(nm, ny) };
}
function proj(sortKey: number, label: string, count: number): DataPoint {
  return { sortKey, label, count: Math.round(count), isProjected: true };
}

/** Holt-Winters additive (undamped, φ=1.0). Requires lastIdx >= 17 (18 complete months). */
export function holtWinters(series: DataPoint[], horizon: number, lastIdx: number): MethodOutput {
  const p = MATURE;
  const completeMonths = lastIdx + 1;

  let L = 0;
  for (let i = 0; i < 12; i++) L += series[i].count;
  L = L / 12;

  const secondEnd = Math.min(completeMonths, 24);
  let sumSecond = 0, secondCt = 0;
  for (let i = 12; i < secondEnd; i++) { sumSecond += series[i].count; secondCt++; }
  let tr = secondCt > 0 ? (sumSecond / secondCt - L) / 12 : 0;

  const seas: number[] = [];
  for (let i = 0; i < 12; i++) seas.push(series[i].count - L);

  for (let idx = 12; idx <= lastIdx; idx++) {
    const y = series[idx].count;
    const sIdx = idx % 12;
    const Lnew = p.alpha * (y - seas[sIdx]) + (1 - p.alpha) * (L + p.phi * tr);
    const trNew = p.beta * (Lnew - L) + (1 - p.beta) * p.phi * tr;
    seas[sIdx] = p.gamma * (y - Lnew) + (1 - p.gamma) * seas[sIdx];
    L = Lnew; tr = trNew;
  }

  const cmgr = L > 0 ? round1(tr / L * 100) : 0;
  const baseMonthIdx = lastIdx % 12;
  const projected: DataPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const nk = nextMonthKey(series[lastIdx].sortKey, h);
    const sIdx = (baseMonthIdx + h) % 12;
    // Damped-trend horizon sum φ+φ²+…+φ^h. At φ=1 the closed form divides by zero;
    // its limit is simply h (undamped: the trend carries linearly).
    const phiSum = Math.abs(p.phi - 1) < 1e-9 ? h : p.phi * (1 - Math.pow(p.phi, h)) / (1 - p.phi);
    projected.push(proj(nk.sortKey, nk.label, L + phiSum * tr + seas[sIdx]));
  }
  return { projected, cmgr };
}

/** Weighted moving average fallback (deseasonalized). Works for any lastIdx >= 0. */
export function weightedAvg(series: DataPoint[], horizon: number, lastIdx: number): MethodOutput {
  const completeMonths = lastIdx + 1;
  const { seasonalIdx } = buildSeasonal(series, lastIdx);

  const weights = [3.0, 2.5, 2.0, 1.5, 1.0, 0.5];
  let wSum = 0, wTot = 0;
  const wLen = Math.min(6, completeMonths);
  for (let i = 0; i < wLen; i++) {
    const idx = lastIdx - i;
    const calM = (series[idx].sortKey % 100) - 1;
    const si = seasonalIdx[calM] ?? 1.0;
    const des = si > 0 ? series[idx].count / si : series[idx].count;
    wSum += weights[i] * des; wTot += weights[i];
  }
  const baseLevel = wTot > 0 ? wSum / wTot : 0;

  let trend = 0;
  if (completeMonths >= 12) {
    let recent6 = 0, prior6 = 0, r6 = 0, p6 = 0;
    for (let i = 0; i < 6 && lastIdx - i >= 0; i++) {
      const idx = lastIdx - i; const calM = (series[idx].sortKey % 100) - 1;
      const si = seasonalIdx[calM] ?? 1.0; recent6 += si > 0 ? series[idx].count / si : series[idx].count; r6++;
    }
    for (let i = 6; i < 12 && lastIdx - i >= 0; i++) {
      const idx = lastIdx - i; const calM = (series[idx].sortKey % 100) - 1;
      const si = seasonalIdx[calM] ?? 1.0; prior6 += si > 0 ? series[idx].count / si : series[idx].count; p6++;
    }
    if (r6 > 0 && p6 > 0) trend = (recent6 / r6 - prior6 / p6) / 6;
  }
  const cmgr = baseLevel > 0 ? round1(trend / baseLevel * 100) : 0;

  const projected: DataPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const nk = nextMonthKey(series[lastIdx].sortKey, h);
    const calM = (nk.sortKey % 100) - 1;
    const si = seasonalIdx[calM] ?? 1.0;
    projected.push(proj(nk.sortKey, nk.label, (baseLevel + h * trend) * si));
  }
  return { projected, cmgr };
}

/**
 * Seasonal indices (ratio to grand avg) over months 0..lastIdx.
 *
 * Deviation from the literal MRPBI port: a bucket needs >=2 samples before its
 * average is trusted as a seasonal ratio. With exactly 1 sample, that sample's
 * seasonal index is definitionally its own value ÷ grand avg — deseasonalizing
 * by it always collapses back to the grand avg, silently erasing 100% of any
 * trend (verified: a strictly-rising 6-point series with one sample per calendar
 * month produces slope=0 in linearTrend/weightedAvg under the un-gated original).
 * That's a real bug for short dollar histories (a location's first 6-11 months),
 * where seasonal decomposition isn't reliable anyway. Buckets with >=2 samples
 * (i.e. any calendar month seen across 2+ years) are unaffected — same behavior
 * as the unmodified port.
 */
export function buildSeasonal(series: DataPoint[], lastIdx: number): { seasonalIdx: number[] } {
  const buckets: number[][] = Array.from({ length: 12 }, () => []);
  let grand = 0, ct = 0;
  for (let i = 0; i <= lastIdx; i++) {
    const calM = (series[i].sortKey % 100) - 1;
    buckets[calM].push(series[i].count); grand += series[i].count; ct++;
  }
  const grandAvg = ct > 0 ? grand / ct : 1;
  const seasonalIdx: number[] = [];
  for (let m = 0; m < 12; m++) {
    if (buckets[m].length >= 2) {
      const avg = buckets[m].reduce((a, b) => a + b, 0) / buckets[m].length;
      seasonalIdx[m] = grandAvg > 0 ? avg / grandAvg : 1.0;
    } else seasonalIdx[m] = 1.0;
  }
  return { seasonalIdx };
}

export function round1(n: number): number { return Math.round(n * 10) / 10; }

/** Seasonal-naive: projected month = same calendar month's most recent actual; else last value. */
export function seasonalNaive(series: DataPoint[], horizon: number, lastIdx: number): MethodOutput {
  const lastByMonth: number[] = new Array(12).fill(NaN);
  for (let i = 0; i <= lastIdx; i++) lastByMonth[(series[i].sortKey % 100) - 1] = series[i].count;
  const lastVal = series[lastIdx].count;
  const projected: DataPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const nk = nextMonthKey(series[lastIdx].sortKey, h);
    const calM = (nk.sortKey % 100) - 1;
    const v = Number.isNaN(lastByMonth[calM]) ? lastVal : lastByMonth[calM];
    projected.push(proj(nk.sortKey, nk.label, v));
  }
  const first = projected[0]?.count ?? lastVal;
  const cmgr = lastVal > 0 ? round1((first - lastVal) / lastVal * 100) : 0;
  return { projected, cmgr };
}

/** Linear-trend regression on deseasonalized series, re-seasonalized on output. */
export function linearTrend(series: DataPoint[], horizon: number, lastIdx: number): MethodOutput {
  const { seasonalIdx } = buildSeasonal(series, lastIdx);
  // OLS over (x=i, y=deseasonalized count) for i=0..lastIdx
  const n = lastIdx + 1;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i <= lastIdx; i++) {
    const calM = (series[i].sortKey % 100) - 1; const si = seasonalIdx[calM] ?? 1.0;
    const y = si > 0 ? series[i].count / si : series[i].count;
    sx += i; sy += y; sxx += i * i; sxy += i * y;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  const projected: DataPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const nk = nextMonthKey(series[lastIdx].sortKey, h);
    const calM = (nk.sortKey % 100) - 1; const si = seasonalIdx[calM] ?? 1.0;
    const base = intercept + slope * (lastIdx + h);
    projected.push(proj(nk.sortKey, nk.label, base * si));
  }
  const level = intercept + slope * lastIdx;
  const cmgr = level > 0 ? round1(slope / level * 100) : 0;
  return { projected, cmgr };
}

/** Simple exponential smoothing (level only), flat-forward × seasonal index. */
export function ses(series: DataPoint[], horizon: number, lastIdx: number): MethodOutput {
  const alpha = 0.3;
  const { seasonalIdx } = buildSeasonal(series, lastIdx);
  let level = series[0].count;
  for (let i = 1; i <= lastIdx; i++) {
    const calM = (series[i].sortKey % 100) - 1; const si = seasonalIdx[calM] ?? 1.0;
    const des = si > 0 ? series[i].count / si : series[i].count;
    level = alpha * des + (1 - alpha) * level;
  }
  const projected: DataPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const nk = nextMonthKey(series[lastIdx].sortKey, h);
    const calM = (nk.sortKey % 100) - 1; const si = seasonalIdx[calM] ?? 1.0;
    projected.push(proj(nk.sortKey, nk.label, level * si));
  }
  return { projected, cmgr: 0 };
}

export const METHOD_MIN_MONTHS: Record<ForecastMethod, number> = {
  'holt-winters': 18, 'weighted-avg': 1, 'seasonal-naive': 1, 'linear-trend': 3, 'ses': 2,
};

/** Resolve requested method against data availability. */
export function resolveMethod(requested: ForecastMethod, completeMonths: number): ForecastMethod {
  const ok = (mth: ForecastMethod) => completeMonths >= METHOD_MIN_MONTHS[mth];
  if (!ok(requested)) return ok('weighted-avg') ? 'weighted-avg' : 'seasonal-naive';
  return requested;
}

export function runMethod(method: ForecastMethod, series: DataPoint[], horizon: number, lastIdx: number): MethodOutput {
  switch (method) {
    case 'holt-winters': return holtWinters(series, horizon, lastIdx);
    case 'weighted-avg': return weightedAvg(series, horizon, lastIdx);
    case 'seasonal-naive': return seasonalNaive(series, horizon, lastIdx);
    case 'linear-trend': return linearTrend(series, horizon, lastIdx);
    case 'ses': return ses(series, horizon, lastIdx);
  }
}

const METHOD_LABEL: Record<ForecastMethod, string> = {
  'holt-winters': 'Holt-Winters', 'weighted-avg': 'Weighted Avg',
  'seasonal-naive': 'Seasonal-Naive', 'linear-trend': 'Linear-Trend', 'ses': 'SES',
};

/** Trim pre-launch ramp and locate the last complete month (drops in-progress current month). */
export function resolveTrimmed(series: DataPoint[], cmk: number): { trimmed: DataPoint[]; lastIdx: number } {
  let rawLastIdx = series.length - 1;
  if (series[rawLastIdx].sortKey === cmk && rawLastIdx > 0) rawLastIdx--;
  const currentLevel = series[rawLastIdx].count;
  const trimmed = trimLeadingRampUp(series, currentLevel);
  let lastIdx = trimmed.length - 1;
  if (trimmed[lastIdx].sortKey === cmk && lastIdx > 0) lastIdx--;
  return { trimmed, lastIdx };
}

/** Anchor index within the trimmed series. Default/out-of-range → lastIdx (no hold-out). */
export function resolveAnchorIdx(trimmed: DataPoint[], lastIdx: number, anchorKey?: number): number {
  if (anchorKey === undefined) return lastIdx;
  const found = trimmed.findIndex(p => p.sortKey === anchorKey);
  if (found < 0) return lastIdx;
  return Math.min(found, lastIdx);
}

export function forecastEntity(
  entity: string, series: DataPoint[], horizon: number, method: ForecastMethod, cmk: number,
  anchorKey?: number,
): EntityForecast {
  const { trimmed, lastIdx } = resolveTrimmed(series, cmk);

  let total = 0;
  for (const dp of trimmed) total += dp.count;

  const anchorIdx = resolveAnchorIdx(trimmed, lastIdx, anchorKey);
  const holdoutLen = lastIdx - anchorIdx;
  const projLen = holdoutLen + horizon;

  const completeMonths = anchorIdx + 1;

  const resolved = resolveMethod(method, completeMonths);
  const out = runMethod(resolved, trimmed, projLen, anchorIdx);

  const label = resolved === method
    ? METHOD_LABEL[resolved]
    : `${METHOD_LABEL[method]} → ${METHOD_LABEL[resolved]} (${completeMonths} mo)`;

  return {
    entity, cmgr: out.cmgr, totalValue: total, forecastMethod: label,
    historical: trimmed, projected: out.projected,
  };
}

export function buildForecastResult(
  seriesMap: Map<string, DataPoint[]>, horizon: number, method: ForecastMethod, now: Date,
  anchorKey?: number,
): EngineForecastResult {
  const cmk = currentMonthKey(now);
  const entities: EntityForecast[] = [];
  const allKeys = new Map<number, string>();

  for (const [entity, series] of seriesMap) {
    if (!series.length) continue;
    const ef = forecastEntity(entity, series, horizon, method, cmk, anchorKey);
    for (const dp of ef.historical) allKeys.set(dp.sortKey, dp.label);
    for (const dp of ef.projected) allKeys.set(dp.sortKey, dp.label);
    entities.push(ef);
  }

  entities.sort((a, b) => b.totalValue - a.totalValue);

  const monthLabels: MonthLabel[] = [...allKeys.keys()].sort((a, b) => a - b)
    .map(k => ({ sortKey: k, label: allKeys.get(k) as string }));

  // Resolved global anchor: caller value, else the latest complete month present.
  const completeKeys = [...allKeys.keys()].filter(k => k < cmk).sort((a, b) => a - b);
  const lastComplete = completeKeys.length ? completeKeys[completeKeys.length - 1] : cmk;
  const resolvedAnchorKey = anchorKey ?? lastComplete;

  // scores attached by the adapter via buildScores (avoids engine↔backtest cycle)
  return { entities, monthLabels, currentMonthKey: cmk, anchorKey: resolvedAnchorKey, scores: [] };
}
