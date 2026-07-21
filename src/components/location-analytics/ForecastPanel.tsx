'use client';

import { useMemo, useState } from 'react';
import type { LocationForecastResponse, TrendMetric } from '@/types/location-analytics';
import { METHOD_OPTIONS, HORIZONS, DEFAULT_METHOD, type MethodSelection } from '@/lib/forecast/types';
import { METRIC_OPTIONS } from './chartTheme';
import { MetricLegend } from './MetricLegend';
import { buildForecastModel } from './forecastModel';
import { ForecastChart } from './ForecastChart';
import { ForecastTable } from './ForecastTable';

/**
 * Forecast tab body. Owns the metric clicker (Revenue / Gross Profit / Net
 * Income), horizon, and forecast-method selectors, runs the selected model
 * client-side over the 24-month history, and renders the forecast chart +
 * SF-style table.
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
  const [method, setMethod] = useState<MethodSelection>(DEFAULT_METHOD);
  const metricLabel = METRIC_OPTIONS.find((m) => m.key === metric)?.label ?? '';

  const model = useMemo(
    () => buildForecastModel(forecast, metric, horizon, method),
    [forecast, metric, horizon, method],
  );

  const handleExport = () => {
    const header = ['Location', ...model.allMonths, 'Method', 'CMGR %'];
    const lines = [header.join(',')];
    for (const loc of model.locations) {
      const vals = model.allMonths.map((m) => {
        if (model.provisionalMonths.includes(m)) return loc.est[m] ?? loc.actual[m] ?? '';
        if (m in loc.future) return loc.future[m];
        if (m in loc.actual) return loc.actual[m];
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
        <div className="flex items-center gap-2">
          <span className={`text-xs uppercase tracking-wide ${subText}`}>Method</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as MethodSelection)}
            className={`px-3 py-2 text-sm rounded-lg border ${rowBorder} ${cardBg}`}
          >
            {METHOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
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
        Projections use the selected model over completed months; seasonality is estimated from up to 24 months of
        history. <strong>CMGR</strong> = the compounded monthly growth rate implied by the projection. Read-only
        estimate — not financial guidance.
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
