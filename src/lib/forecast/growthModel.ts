/**
 * Capped median month-over-month growth — pure TS, no I/O (runs client-side).
 *
 * This is the robust method documented for MedRock's forecasting (the Claude
 * research model in salesforce-conversion `aws-rebuild/07-reports-analytics/
 * survey.md` §13, and the directors' 2026 Forecast spreadsheet in
 * `docs/forecast_spreadsheet_analysis.md`):
 *   - month-over-month growth ratios from history (positive denominators only)
 *   - each ratio CAPPED to [GROWTH_FLOOR, GROWTH_CAP] so a one-off spike can't
 *     dominate (Mature tier: -5% .. +10% / month)
 *   - take the MEDIAN ratio (robust to outliers — beats a mean here)
 *   - compound forward from the latest actual
 *
 * Replaces the earlier Holt-Winters engine, which had no cap/robustness and so
 * extrapolated one-time accounting spikes into runaway projections.
 * (Seasonal-index multiplier from the full model is a deferred follow-up.)
 */

export type ForecastMethod = 'Capped growth' | 'Flat';

export interface ForecastResult {
  method: ForecastMethod;
  fitted: number[]; // in-sample one-step fitted values (same length as history)
  forecast: number[]; // length = horizon
  cmgr: number; // capped median monthly growth rate, as a percent
}

/** Mature-tier caps from the forecast research / directors' model. Tweak here. */
export const GROWTH_CAP = 1.1; // max +10% / month
export const GROWTH_FLOOR = 0.95; // max -5% / month

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Forecast `horizon` months ahead from a numeric monthly history. */
export function forecastSeries(history: number[], horizon: number): ForecastResult {
  const n = history.length;
  if (horizon <= 0 || n === 0) {
    return { method: 'Flat', fitted: [...history], forecast: [], cmgr: 0 };
  }

  // Capped month-over-month ratios where the prior month is positive.
  const ratios: number[] = [];
  for (let i = 1; i < n; i++) {
    const prev = history[i - 1];
    if (prev > 0) ratios.push(clamp(history[i] / prev, GROWTH_FLOOR, GROWTH_CAP));
  }

  const hasRate = ratios.length >= 2;
  const rate = hasRate ? clamp(median(ratios), GROWTH_FLOOR, GROWTH_CAP) : 1;

  const fitted = history.map((v, i) => (i === 0 ? v : history[i - 1] * rate));

  const forecast: number[] = [];
  let cur = history[n - 1];
  for (let k = 0; k < horizon; k++) {
    cur = cur * rate;
    forecast.push(cur);
  }

  return { method: hasRate ? 'Capped growth' : 'Flat', fitted, forecast, cmgr: (rate - 1) * 100 };
}
