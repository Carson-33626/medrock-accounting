import { Basis, TrendMetric } from '@/types/location-analytics';

/** One cell of a manual forecast: a location's expected dollar amount for one month. */
export interface ManualForecastEntry {
  location: string;
  /** year * 100 + month — same convention as the forecast engine. */
  sortKey: number;
  amount: number;
}

/** The client-writable shape (POST body / PUT body). */
export interface ManualForecastInput {
  name: string;
  metric: TrendMetric;
  basis: Basis;
  entries: ManualForecastEntry[];
}

/** A persisted manual forecast as returned to the FE. */
export interface ManualForecast extends ManualForecastInput {
  id: number;
  /** Display-only attribution — not an ownership lock. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const MAX_NAME_LEN = 120;
export const MAX_ENTITY_LEN = 120;
export const MAX_ENTRIES = 5_000;
export const MIN_YEAR = 2020;
export const MAX_YEAR = 2035;
