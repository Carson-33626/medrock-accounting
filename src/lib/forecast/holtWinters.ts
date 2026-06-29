/**
 * Damped exponential-smoothing forecasts — pure TS, no I/O (runs client-side).
 *
 * Mirrors the Salesforce growthForecast approach:
 *  - >= 24 obs  → additive damped Holt-Winters (level + trend + seasonality, m=12)
 *  - 6..23 obs  → damped Holt linear trend (level + trend)
 *  - < 6 obs    → recent-weighted moving average (flat carry-forward)
 * Damping (phi=0.9) flattens long-horizon growth so projections stay realistic.
 * Smoothing params are chosen by a small grid search minimizing in-sample SSE.
 */

export type ForecastMethod = 'Holt-Winters' | 'Damped trend' | 'Weighted avg';

export interface ForecastResult {
  method: ForecastMethod;
  fitted: number[]; // in-sample one-step fitted values (same length as history)
  forecast: number[]; // length = horizon
  cmgr: number; // compound monthly growth rate implied by the forecast, as a percent
}

const PHI = 0.9; // damping factor
const SEASON = 12; // monthly seasonality
const GRID = [0.1, 0.2, 0.3, 0.5] as const;

/** Σ_{i=1..h} phi^i — damped cumulative trend multiplier. */
function dampSum(h: number): number {
  let sum = 0;
  let p = PHI;
  for (let i = 0; i < h; i++) {
    sum += p;
    p *= PHI;
  }
  return sum;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** CMGR (%) implied by going from the last actual to the final forecast over `horizon` months. */
function cmgrPercent(lastActual: number, finalForecast: number, horizon: number): number {
  if (horizon <= 0 || lastActual <= 0 || finalForecast <= 0) return 0;
  return (Math.pow(finalForecast / lastActual, 1 / horizon) - 1) * 100;
}

interface RunOutput {
  fitted: number[];
  forecast: number[];
  sse: number;
}

function runDampedTrend(history: number[], horizon: number, alpha: number, beta: number): RunOutput {
  const n = history.length;
  let level = history[0];
  let trend = n > 1 ? history[1] - history[0] : 0;
  const fitted: number[] = [history[0]];
  let sse = 0;

  for (let t = 1; t < n; t++) {
    const oneStep = level + PHI * trend;
    fitted.push(oneStep);
    sse += (history[t] - oneStep) ** 2;
    const newLevel = alpha * history[t] + (1 - alpha) * oneStep;
    trend = beta * (newLevel - level) + (1 - beta) * PHI * trend;
    level = newLevel;
  }

  const forecast: number[] = [];
  for (let h = 1; h <= horizon; h++) forecast.push(level + dampSum(h) * trend);
  return { fitted, forecast, sse };
}

function runHoltWinters(
  history: number[],
  horizon: number,
  alpha: number,
  beta: number,
  gamma: number,
): RunOutput {
  const n = history.length;
  const m = SEASON;

  // Initialise level/trend from the first two seasons, seasonals from season 1.
  const firstSeason = history.slice(0, m);
  const secondSeason = history.slice(m, 2 * m);
  let level = mean(firstSeason);
  let trend = (mean(secondSeason) - mean(firstSeason)) / m;
  const seasonal = firstSeason.map((y) => y - level); // additive seasonal indices

  const fitted: number[] = [];
  let sse = 0;

  for (let t = 0; t < n; t++) {
    const sIdx = t % m;
    if (t < m) {
      fitted.push(history[t]); // warmup — no fit error counted
      continue;
    }
    const prevSeasonal = seasonal[sIdx];
    const oneStep = level + PHI * trend + prevSeasonal;
    fitted.push(oneStep);
    sse += (history[t] - oneStep) ** 2;

    const newLevel = alpha * (history[t] - prevSeasonal) + (1 - alpha) * (level + PHI * trend);
    trend = beta * (newLevel - level) + (1 - beta) * PHI * trend;
    seasonal[sIdx] = gamma * (history[t] - newLevel) + (1 - gamma) * prevSeasonal;
    level = newLevel;
  }

  const forecast: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    forecast.push(level + dampSum(h) * trend + seasonal[(n - 1 + h) % m]);
  }
  return { fitted, forecast, sse };
}

function weightedAverage(history: number[], horizon: number): ForecastResult {
  const n = history.length;
  const k = Math.min(6, n);
  const recent = history.slice(n - k);
  let wsum = 0;
  let weight = 0;
  recent.forEach((y, i) => {
    const w = i + 1; // more recent = heavier
    wsum += w * y;
    weight += w;
  });
  const avg = weight ? wsum / weight : 0;
  const forecast = Array.from({ length: horizon }, () => avg);
  const cmgr = n > 1 && history[0] > 0 && history[n - 1] > 0
    ? (Math.pow(history[n - 1] / history[0], 1 / (n - 1)) - 1) * 100
    : 0;
  return { method: 'Weighted avg', fitted: [...history], forecast, cmgr };
}

function bestOf(
  history: number[],
  horizon: number,
  run: (a: number, b: number, g: number) => RunOutput,
  useGamma: boolean,
): RunOutput {
  let best: RunOutput | null = null;
  for (const a of GRID) {
    for (const b of GRID) {
      for (const g of useGamma ? GRID : [0]) {
        const out = run(a, b, g);
        if (!best || out.sse < best.sse) best = out;
      }
    }
  }
  // GRID is non-empty, so best is always assigned.
  return best as RunOutput;
}

/** Forecast `horizon` months ahead from a numeric monthly history. */
export function forecastSeries(history: number[], horizon: number): ForecastResult {
  const n = history.length;
  const lastActual = n > 0 ? history[n - 1] : 0;

  if (horizon <= 0 || n === 0) {
    return { method: 'Weighted avg', fitted: [...history], forecast: [], cmgr: 0 };
  }

  if (n >= 2 * SEASON) {
    const out = bestOf(history, horizon, (a, b, g) => runHoltWinters(history, horizon, a, b, g), true);
    return {
      method: 'Holt-Winters',
      fitted: out.fitted,
      forecast: out.forecast,
      cmgr: cmgrPercent(lastActual, out.forecast[out.forecast.length - 1], horizon),
    };
  }

  if (n >= 6) {
    const out = bestOf(history, horizon, (a, b) => runDampedTrend(history, horizon, a, b), false);
    return {
      method: 'Damped trend',
      fitted: out.fitted,
      forecast: out.forecast,
      cmgr: cmgrPercent(lastActual, out.forecast[out.forecast.length - 1], horizon),
    };
  }

  return weightedAverage(history, horizon);
}
