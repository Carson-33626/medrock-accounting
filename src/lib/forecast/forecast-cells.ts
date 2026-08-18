// Pure cell/aggregation math shared by the on-screen forecast table
// (ForecastTable) and the CSV/XLSX exporters (forecast-export). Extracted so
// the exported Total row can never drift from the UI's Total column.
import type { ForecastLocation, ForecastModel } from '@/components/location-analytics/forecastModel';

export type CellKind = 'actual' | 'dual' | 'projected' | 'empty';
export interface CellView {
  kind: CellKind;
  value: number;
  estValue: number | null;
}

export function cellFor(loc: ForecastLocation, month: string, model: ForecastModel): CellView {
  if (model.provisionalMonths.includes(month)) {
    return { kind: 'dual', value: loc.actual[month] ?? 0, estValue: loc.est[month] ?? 0 };
  }
  if (month in loc.future) {
    return { kind: 'projected', value: loc.future[month], estValue: null };
  }
  if (month in loc.actual) {
    return { kind: 'actual', value: loc.actual[month], estValue: null };
  }
  return { kind: 'empty', value: 0, estValue: null };
}

/** Aggregate one month across all locations for the Total column. */
export function totalCell(model: ForecastModel, month: string): CellView {
  let actualSum = 0;
  let estSum = 0;
  let projSum = 0;
  let kind: CellKind = 'empty';
  for (const loc of model.locations) {
    const c = cellFor(loc, month, model);
    if (c.kind === 'actual') {
      actualSum += c.value;
      kind = 'actual';
    } else if (c.kind === 'dual') {
      actualSum += c.value;
      estSum += c.estValue ?? 0;
      kind = 'dual';
    } else if (c.kind === 'projected') {
      projSum += c.value;
      kind = 'projected';
    }
  }
  if (kind === 'dual') return { kind, value: actualSum, estValue: estSum };
  if (kind === 'projected') return { kind, value: projSum, estValue: null };
  return { kind, value: actualSum, estValue: null };
}

/** CMGR (%) from last-actual to final-forecast for an arbitrary summed series. */
export function cmgrFrom(lastActual: number, finalForecast: number, horizon: number): number {
  if (horizon <= 0 || lastActual <= 0 || finalForecast <= 0) return 0;
  return (Math.pow(finalForecast / lastActual, 1 / horizon) - 1) * 100;
}

/** Total-column CMGR: the summed series, anchored on the last fully-closed month. */
export function computeTotalCmgr(model: ForecastModel): number {
  const trained = model.completedMonths.filter((m) => !model.provisionalMonths.includes(m));
  const lastActualMonth = trained[trained.length - 1];
  const lastFutureMonth = model.futureMonths[model.futureMonths.length - 1];
  if (!lastActualMonth || !lastFutureMonth) return 0;
  const lastActual = model.locations.reduce((s, l) => s + (l.actual[lastActualMonth] ?? 0), 0);
  const finalForecast = model.locations.reduce((s, l) => s + (l.future[lastFutureMonth] ?? 0), 0);
  const periods = model.provisionalMonths.length + model.futureMonths.length;
  return cmgrFrom(lastActual, finalForecast, periods);
}
