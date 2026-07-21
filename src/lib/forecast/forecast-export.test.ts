import { describe, it, expect } from 'vitest';
import { buildExportModel } from './forecast-export';
import type { ForecastModel } from '@/components/location-analytics/forecastModel';

const model: ForecastModel = {
  completedMonths: ['2026-01', '2026-02'],
  currentMonthKey: '2026-02',
  provisionalMonths: ['2026-02'],
  futureMonths: ['2026-03'],
  allMonths: ['2026-01', '2026-02', '2026-03'],
  locations: [{
    qbLocation: 'MedRock FL', label: 'Florida', state: 'FL', connected: true, openedMonth: null,
    method: 'Holt-Winters', cmgr: 4.2,
    actual: { '2026-01': 1000, '2026-02': 1100 }, est: { '2026-02': 1080 }, future: { '2026-03': 1200 },
    connectValue: 1000, lastTrainMonth: '2026-01',
  }],
  scores: [], anchorMonth: '2026-01', showProjection: true,
};

describe('buildExportModel', () => {
  it('emits one row per location with month columns filled by actual/est/future', () => {
    const { headers, rows } = buildExportModel(model, 'Revenue');
    expect(headers.slice(0, 3)).toEqual(['Location', 'Method', 'CMGR %']);
    expect(headers).toContain('2026-03');
    expect(rows).toHaveLength(1);
    const [loc, method, cmgr, jan, feb, mar] = rows[0];
    expect(loc).toBe('Florida');
    expect(method).toBe('Holt-Winters');
    expect(cmgr).toBe('4.2');
    expect(jan).toBe(1000);
    expect(feb).toBe(1080);   // provisional → est preferred
    expect(mar).toBe(1200);   // future
  });
});
