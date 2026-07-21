import { describe, it, expect } from 'vitest';
import { buildForecastModel } from './forecastModel';
import type { LocationForecastResponse } from '@/types/location-analytics';

function resp(): LocationForecastResponse {
  const months: string[] = [];
  for (let i = 0; i < 24; i++) {
    const y = 2024 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  const currentMonthKey = months[months.length - 1];
  const mk = (base: number) => months.map((month, i) => ({
    month, revenue: base + i * 100, cogs: 0, grossProfit: base + i * 100, netIncome: base + i * 50,
  }));
  return {
    basis: 'Accrual',
    months,
    currentMonthKey,
    series: [
      { qbLocation: 'MedRock FL', label: 'Florida', state: 'FL', connected: true, openedMonth: null, points: mk(5000) },
      { qbLocation: 'MedRock TN', label: 'Tennessee', state: 'TN', connected: true, openedMonth: null, points: mk(3000) },
    ],
    generatedAt: new Date().toISOString(),
  };
}

describe('buildForecastModel', () => {
  it('produces a projection per location for a chosen method + horizon', () => {
    const model = buildForecastModel(resp(), 'revenue', 6, 'holt-winters');
    expect(model.locations).toHaveLength(2);
    expect(model.futureMonths.length).toBeGreaterThan(0);
    const fl = model.locations.find((l) => l.qbLocation === 'MedRock FL')!;
    expect(Object.keys(fl.future).length).toBeGreaterThan(0);
    expect(model.showProjection).toBe(true);
    expect(model.scores.length).toBe(2 * 5);

    const cm = model.currentMonthKey!;
    expect(fl.est[cm]).toBeGreaterThan(0);          // current-month estimate present
    expect(model.provisionalMonths).toContain(cm);
    expect(model.futureMonths).not.toContain(cm);   // no provisional/future overlap
  });
  it('hides projection when method = none but still returns history + scores', () => {
    const model = buildForecastModel(resp(), 'revenue', 6, 'none');
    expect(model.showProjection).toBe(false);
    const fl = model.locations.find((l) => l.qbLocation === 'MedRock FL')!;
    expect(Object.keys(fl.actual).length).toBeGreaterThan(0);
  });
  it('opens a hold-out window when an earlier anchor is supplied', () => {
    const full = resp();
    const anchor = full.months[full.months.length - 4]; // 3 months back
    const model = buildForecastModel(full, 'revenue', 6, 'holt-winters', anchor);
    expect(model.provisionalMonths.length).toBeGreaterThan(0);
    expect(model.anchorMonth).toBe(anchor);
  });
});
