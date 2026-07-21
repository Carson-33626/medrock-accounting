import { describe, it, expect } from 'vitest';
import { computeVariance } from './manual-forecast-variance';
import type { ForecastModel } from '@/components/location-analytics/forecastModel';
import type { ManualForecast } from '@/types/manual-forecast';

const model: ForecastModel = {
  completedMonths: ['2026-01'], currentMonthKey: '2026-02',
  provisionalMonths: ['2026-02'], futureMonths: ['2026-03'],
  allMonths: ['2026-01', '2026-02', '2026-03'],
  locations: [{
    qbLocation: 'MedRock FL', label: 'Florida', state: 'FL', connected: true, openedMonth: null,
    method: 'Holt-Winters', cmgr: 0,
    actual: { '2026-01': 1000 }, est: { '2026-02': 1080 }, future: { '2026-03': 1200 },
    connectValue: 1000, lastTrainMonth: '2026-01',
  }],
  scores: [], anchorMonth: '2026-01', showProjection: true,
};
const manual: ManualForecast = {
  id: 1, name: 'Plan', metric: 'revenue', basis: 'Accrual', createdBy: 'x', createdAt: '', updatedAt: '',
  entries: [
    { location: 'MedRock FL', sortKey: 202601, amount: 1100 }, // vs actual 1000 → +10% close
    { location: 'MedRock FL', sortKey: 202603, amount: 1500 }, // vs future 1200 → +25% over
  ],
};

describe('computeVariance', () => {
  it('compares manual vs actual (completed) and projection (future)', () => {
    const groups = computeVariance(model, manual, { showProjected: true });
    expect(groups).toHaveLength(1);
    const rows = groups[0].rows;
    const jan = rows.find((r) => r.sortKey === 202601)!;
    const mar = rows.find((r) => r.sortKey === 202603)!;
    expect(jan.systemKind).toBe('actual');
    expect(jan.status).toBe('close');
    expect(mar.systemKind).toBe('projected');
    expect(mar.status).toBe('over');
  });
  it('drops projected comparisons when showProjected is false', () => {
    const groups = computeVariance(model, manual, { showProjected: false });
    const mar = groups[0].rows.find((r) => r.sortKey === 202603)!;
    expect(mar.system).toBeNull();
  });
});
