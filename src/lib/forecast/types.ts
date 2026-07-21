// Ported from MRPBI forecast.types.ts + forecast-types.ts. Tiering removed: HW params are
// chosen by history length, not script-count tiers (dollar P&L has no meaningful tiers).

export type ForecastMethod =
  | 'holt-winters' | 'weighted-avg' | 'seasonal-naive' | 'linear-trend' | 'ses';

export const FORECAST_METHODS: ForecastMethod[] =
  ['holt-winters', 'weighted-avg', 'seasonal-naive', 'linear-trend', 'ses'];
export const DEFAULT_METHOD: ForecastMethod = 'holt-winters';
export const HORIZONS: number[] = [3, 6, 9, 12];

/** 'none' is UI-only: history renders, projection is hidden. */
export type MethodSelection = ForecastMethod | 'none';
export const FETCH_METHOD_FOR_NONE: ForecastMethod = 'holt-winters';

export const METHOD_OPTIONS: { value: MethodSelection; label: string }[] = [
  { value: 'none', label: 'None (no projection)' },
  { value: 'holt-winters', label: 'Holt-Winters' },
  { value: 'weighted-avg', label: 'Weighted Moving Avg' },
  { value: 'seasonal-naive', label: 'Seasonal-Naive' },
  { value: 'linear-trend', label: 'Linear-Trend Regression' },
  { value: 'ses', label: 'Simple Exp. Smoothing' },
];

export interface DataPoint {
  label: string;      // 'YYYY-MM'
  sortKey: number;    // year*100 + month
  count: number;      // the selected metric's dollar value for the month (may be negative)
  isProjected: boolean;
}
export interface MonthLabel { label: string; sortKey: number; }
export interface MethodOutput { projected: DataPoint[]; cmgr: number; }

export interface EntityForecast {
  entity: string;         // qbLocation, e.g. 'MedRock FL'
  cmgr: number;           // % monthly trend, 1 decimal
  totalValue: number;     // Σ historical count (used for volume ordering + WAPE weighting)
  forecastMethod: string; // resolved label, may include fallback note
  historical: DataPoint[];
  projected: DataPoint[];
}
export interface MethodScore {
  absErrSum: number; actualSum: number; holdoutMonths: number; trainable: boolean;
}
export interface EntityMethodScore extends MethodScore {
  entity: string; method: ForecastMethod;
}
export interface EngineForecastResult {
  entities: EntityForecast[];
  monthLabels: MonthLabel[];
  currentMonthKey: number;
  anchorKey: number;
  scores: EntityMethodScore[];
}
