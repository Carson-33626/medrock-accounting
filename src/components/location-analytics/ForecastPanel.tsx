'use client';

import { useMemo, useState } from 'react';
import type { LocationForecastResponse, TrendMetric } from '@/types/location-analytics';
import { METRIC_OPTIONS } from './chartTheme';
import { MetricLegend } from './MetricLegend';
import { buildForecastModel } from './forecastModel';
import { ForecastChart } from './ForecastChart';
import { ForecastTable } from './ForecastTable';

const HORIZONS = [3, 6, 12] as const;

/**
 * Forecast tab body. Owns the metric clicker (Revenue / Gross Profit / Net
 * Income) and horizon selector, runs Holt-Winters client-side over the 24-month
 * history, and renders the forecast chart + SF-style table.
 */
export function ForecastPanel({
  forecast,
  darkMode,
  cardBg,
  subText,
  rowBorder,
}: {
  forecast: LocationForecastResponse;
  darkMode: boolean;
  cardBg: string;
  subText: string;
  rowBorder: string;
}) {
  const [metric, setMetric] = useState<TrendMetric>('revenue');
  const [horizon, setHorizon] = useState<number>(6);
  const metricLabel = METRIC_OPTIONS.find((m) => m.key === metric)?.label ?? '';

  const model = useMemo(() => buildForecastModel(forecast, metric, horizon), [forecast, metric, horizon]);

  const handleExport = () => {
    const header = ['Location', ...model.allMonths, 'Method', 'CMGR %'];
    const lines = [header.join(',')];
    for (const loc of model.locations) {
      const vals = model.allMonths.map((m) => {
        if (m !== model.currentMonthKey && m in loc.actual) return loc.actual[m];
        if (m === model.currentMonthKey) return loc.estCurrent ?? loc.actual[m] ?? '';
        if (m in loc.future) return loc.future[m];
        return '';
      });
      lines.push([loc.label, ...vals, loc.method, loc.cmgr.toFixed(1)].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `location-forecast_${metric}_${horizon}mo.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const toggleBase = (active: boolean): string =>
    `px-4 py-2 text-sm font-medium transition-colors ${
      active ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
    }`;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className={`text-xs uppercase tracking-wide ${subText}`}>Metric</span>
          <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
            {METRIC_OPTIONS.map((m) => (
              <button
                key={m.key}
                onClick={() => setMetric(m.key)}
                className={toggleBase(metric === m.key)}
                style={metric === m.key ? { backgroundColor: '#5e3b8d' } : undefined}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs uppercase tracking-wide ${subText}`}>Horizon</span>
          <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
            {HORIZONS.map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={toggleBase(horizon === h)}
                style={horizon === h ? { backgroundColor: '#5e3b8d' } : undefined}
              >
                {h} mo
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={handleExport}
          className={`ml-auto px-3 py-2 text-sm rounded-lg border ${rowBorder} ${cardBg}`}
        >
          CSV
        </button>
      </div>

      <MetricLegend subText={subText} />

      {/* Method note */}
      <div className={`rounded-xl shadow-sm p-4 text-xs ${cardBg} ${subText}`}>
        Projections use <strong>damped Holt-Winters exponential smoothing</strong> (level + trend + seasonality)
        on up to 24 months of QuickBooks history, with damping that flattens long-horizon growth. Locations with
        2+ years of history use Holt-Winters; shorter histories fall back to a damped trend or weighted average
        (see the Method column). <strong>CMGR</strong> = compound monthly growth rate implied by the projection.
        Read-only estimate — not financial guidance.
      </div>

      <ForecastChart model={model} darkMode={darkMode} cardBg={cardBg} subText={subText} metricLabel={metricLabel} />
      <ForecastTable
        model={model}
        darkMode={darkMode}
        cardBg={cardBg}
        subText={subText}
        rowBorder={rowBorder}
        metricLabel={metricLabel}
      />
    </div>
  );
}
