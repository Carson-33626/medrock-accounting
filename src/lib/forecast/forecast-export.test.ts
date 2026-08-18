import { describe, it, expect } from 'vitest';
import { buildExportModel, buildVarianceExportModel } from './forecast-export';
import type { VarianceExport } from './forecast-export';
import type { ForecastModel } from '@/components/location-analytics/forecastModel';
import type { VarianceGroup } from './manual-forecast-variance';

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

const twoLocModel: ForecastModel = {
  ...model,
  locations: [
    ...model.locations,
    {
      qbLocation: 'MedRock TN', label: 'Tennessee', state: 'TN', connected: true, openedMonth: null,
      method: 'Linear', cmgr: 2.0,
      actual: { '2026-01': 500, '2026-02': 550 }, est: { '2026-02': 540 }, future: { '2026-03': 600 },
      connectValue: 500, lastTrainMonth: '2026-01',
    },
  ],
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

  it('records the metric in the export title', () => {
    expect(buildExportModel(model, 'Gross Profit').title).toBe('Gross Profit — actuals & forecast by month');
  });

  it('emits a Total row summing every location, with the total CMGR', () => {
    const { totalRow } = buildExportModel(twoLocModel, 'Revenue');
    const [label, method, cmgr, jan, feb, mar] = totalRow;
    expect(label).toBe('Total');
    expect(method).toBe('');
    expect(jan).toBe(1500);   // 1000 + 500 actual
    expect(feb).toBe(1620);   // 1080 + 540 — provisional keeps the est precedence
    expect(mar).toBe(1800);   // 1200 + 600 projected
    // Summed-series CMGR: last actual 1500 (2026-01) → final forecast 1800
    // (2026-03) over 2 periods (1 provisional + 1 future) = 20%^(1/2) - 1.
    expect(cmgr).toBe(((Math.pow(1800 / 1500, 1 / 2) - 1) * 100).toFixed(1));
  });
});

describe('buildVarianceExportModel', () => {
  const groups: VarianceGroup[] = [{
    location: 'MedRock FL',
    label: 'Florida',
    rows: [
      {
        location: 'MedRock FL', sortKey: 202601, label: "Jan '26", manual: 900,
        system: 1000, systemKind: 'actual', delta: -100, deltaPct: -10, status: 'close',
      },
      {
        location: 'MedRock FL', sortKey: 202603, label: "Mar '26", manual: 1500,
        system: null, systemKind: null, delta: null, deltaPct: null, status: 'none',
      },
    ],
    subtotal: { manual: 900, system: 1000, delta: -100, deltaPct: -10, status: 'close' },
  }];
  const variance: VarianceExport = { overlayName: 'Board plan', groups };

  it('flattens groups into per-month rows plus a subtotal row', () => {
    const { title, headers, rows } = buildVarianceExportModel(variance, 'Revenue');
    expect(title).toBe('Revenue — manual vs. system variance (overlay: Board plan)');
    expect(headers).toEqual(['Location', 'Month', 'Manual', 'System', 'System kind', 'Δ', 'Δ %', 'Status']);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(['Florida', "Jan '26", 900, 1000, 'actual', -100, '-10.0', 'Close']);
    expect(rows[1]).toEqual(['Florida', "Mar '26", 1500, '', '', '', '', '—']);
    expect(rows[2]).toEqual(['Florida', 'Subtotal', 900, 1000, '', -100, '-10.0', 'Close']);
  });
});
