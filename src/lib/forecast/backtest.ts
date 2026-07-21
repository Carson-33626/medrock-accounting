// Ported from MRPBI power_bi_replacement_be/src/forecast/forecast.backtest.ts.
// Adaptations per task-3-brief.md: tier gating removed entirely — the dollar (net income)
// domain has no script-count tiers, so a single Holt-Winters param set applies regardless
// of history/level (see engine.ts). isTrainable is therefore a pure month-count check.
import {
  resolveTrimmed, resolveAnchorIdx, runMethod, METHOD_MIN_MONTHS,
} from './engine';
import { DataPoint, EntityMethodScore, ForecastMethod, FORECAST_METHODS, MethodScore } from './types';

/** Can `method` be fitted on the `completeMonths` of history behind the anchor? */
function isTrainable(method: ForecastMethod, completeMonths: number): boolean {
  return completeMonths >= METHOD_MIN_MONTHS[method];
}

/** WAPE error components per method for one entity, forecasting the hold-out from the anchor. */
export function scoreEntity(series: DataPoint[], anchorKey: number, cmk: number): Record<ForecastMethod, MethodScore> {
  const { trimmed, lastIdx } = resolveTrimmed(series, cmk);
  const anchorIdx = resolveAnchorIdx(trimmed, lastIdx, anchorKey);
  const holdoutLen = lastIdx - anchorIdx;
  const completeMonths = anchorIdx + 1;

  const out = {} as Record<ForecastMethod, MethodScore>;
  for (const method of FORECAST_METHODS) {
    const trainable = holdoutLen > 0 && isTrainable(method, completeMonths);
    if (!trainable) {
      out[method] = { absErrSum: 0, actualSum: 0, holdoutMonths: 0, trainable: false };
      continue;
    }
    // Project exactly the hold-out span from the anchor (no need for the extra horizon here).
    const projected = runMethod(method, trimmed, holdoutLen, anchorIdx).projected;
    let absErrSum = 0, actualSum = 0, holdoutMonths = 0;
    for (let h = 1; h <= holdoutLen; h++) {
      const actual = trimmed[anchorIdx + h];
      const forecast = projected[h - 1];
      if (!actual || !forecast) continue;
      absErrSum += Math.abs(actual.count - forecast.count);
      actualSum += actual.count;
      holdoutMonths++;
    }
    out[method] = { absErrSum, actualSum, holdoutMonths, trainable: true };
  }
  return out;
}

/** Flatten per-entity scores to one row per (entity, method). */
export function buildScores(
  seriesMap: Map<string, DataPoint[]>, anchorKey: number, cmk: number,
): EntityMethodScore[] {
  const rows: EntityMethodScore[] = [];
  for (const [entity, series] of seriesMap) {
    if (!series.length) continue;
    const scores = scoreEntity(series, anchorKey, cmk);
    for (const method of FORECAST_METHODS) rows.push({ entity, method, ...scores[method] });
  }
  return rows;
}
