'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LocationForecastResponse, TrendMetric } from '@/types/location-analytics';
import type { ManualForecast } from '@/types/manual-forecast';
import { METHOD_OPTIONS, HORIZONS, DEFAULT_METHOD, type MethodSelection } from '@/lib/forecast/types';
import { rankMethods, accuracyLabel } from '@/lib/forecast/scores';
import { skToYm } from '@/lib/forecast/engine';
import { computeVariance } from '@/lib/forecast/manual-forecast-variance';
import { METRIC_OPTIONS } from './chartTheme';
import { MetricLegend } from './MetricLegend';
import { MethodAccuracyStrip } from './MethodAccuracyStrip';
import { buildForecastModel } from './forecastModel';
import { ForecastChart } from './ForecastChart';
import { ForecastTable } from './ForecastTable';
import { VarianceTable } from './VarianceTable';
import { ManualForecastTab } from './ManualForecastTab';
import { exportForecastCsv, exportForecastXlsx, exportForecastPdf } from '@/lib/forecast/forecast-export';

function labelForMetric(metric: TrendMetric): string {
  return METRIC_OPTIONS.find((m) => m.key === metric)?.label ?? metric;
}

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
  const [subTab, setSubTab] = useState<'forecast' | 'manual'>('forecast');
  const [metric, setMetric] = useState<TrendMetric>('revenue');
  const [horizon, setHorizon] = useState<number>(6);
  const [method, setMethod] = useState<MethodSelection>(DEFAULT_METHOD);
  const [anchor, setAnchor] = useState<string | undefined>(undefined);
  const metricLabel = METRIC_OPTIONS.find((m) => m.key === metric)?.label ?? '';

  // Manual-overlay selection — loaded from the same saved-forecast list the Manual
  // Forecasts sub-tab manages. Only forecasts matching the current metric are selectable.
  const [savedForecasts, setSavedForecasts] = useState<ManualForecast[]>([]);
  const [overlay, setOverlay] = useState<ManualForecast | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/location-analytics/manual-forecast')
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load manual forecasts (${res.status})`);
        return res.json() as Promise<ManualForecast[]>;
      })
      .then((data) => {
        if (!cancelled) setSavedForecasts(data);
      })
      .catch(() => {
        // Overlay is an optional assist — a failed load just leaves the selector at "None".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A metric switch (or a basis mismatch vs. the current view) can strand the
  // selected overlay — drop it.
  useEffect(() => {
    setOverlay((prev) => (prev && (prev.metric !== metric || prev.basis !== forecast.basis) ? null : prev));
  }, [metric, forecast.basis]);

  const model = useMemo(
    () => buildForecastModel(forecast, metric, horizon, method, anchor),
    [forecast, metric, horizon, method, anchor],
  );

  // Overlay entries (sortKey-keyed, per qbLocation) -> chart rows (YYYY-MM-keyed, per label).
  const overlayByLabel = useMemo((): Record<string, Record<string, number>> | undefined => {
    if (!overlay) return undefined;
    const labelByQbLocation = new Map(model.locations.map((l) => [l.qbLocation, l.label]));
    const byLabel: Record<string, Record<string, number>> = {};
    for (const entry of overlay.entries) {
      const label = labelByQbLocation.get(entry.location);
      if (!label) continue;
      const { y, m } = skToYm(entry.sortKey);
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      (byLabel[label] ??= {})[ym] = entry.amount;
    }
    return byLabel;
  }, [overlay, model.locations]);

  const varianceGroups = useMemo(
    () => (overlay ? computeVariance(model, overlay, { showProjected: model.showProjection }) : null),
    [overlay, model],
  );

  const months = model.completedMonths;
  const stepAnchor = (dir: -1 | 1) => {
    const idx = months.indexOf(model.anchorMonth);
    const next = Math.min(months.length - 1, Math.max(0, (idx < 0 ? months.length - 1 : idx) + dir));
    setAnchor(next === months.length - 1 ? undefined : months[next]);
  };

  const ranked = useMemo(() => rankMethods(model.scores, new Set()), [model.scores]);
  const anyScored = ranked.some((r) => r.wape !== null);
  const recommended = ranked.find((r) => r.recommended)?.method;

  // Auto-adopt the backtest-recommended method until the user explicitly picks one
  // (via the dropdown or the accuracy strip).
  const userPickedRef = useRef(false);
  useEffect(() => {
    if (!userPickedRef.current && recommended) {
      setMethod(recommended);
    }
  }, [recommended]);

  const exportFilename = `location-forecast_${metric}_${horizon}mo`;
  const handleExportCsv = () => exportForecastCsv(model, metricLabel, exportFilename);
  const handleExportXlsx = () => {
    void exportForecastXlsx(model, metricLabel, exportFilename);
  };
  const handleExportPdf = () => exportForecastPdf();

  const toggleBase = (active: boolean): string =>
    `px-4 py-2 text-sm font-medium transition-colors ${
      active ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
    }`;

  return (
    <div className="space-y-4">
      {/* Sub-tab switch */}
      <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
        <button
          onClick={() => setSubTab('forecast')}
          className={toggleBase(subTab === 'forecast')}
          style={subTab === 'forecast' ? { backgroundColor: '#5e3b8d' } : undefined}
        >
          Forecast
        </button>
        <button
          onClick={() => setSubTab('manual')}
          className={toggleBase(subTab === 'manual')}
          style={subTab === 'manual' ? { backgroundColor: '#5e3b8d' } : undefined}
        >
          Manual Forecasts
        </button>
      </div>

      {subTab === 'manual' ? (
        <ManualForecastTab forecast={forecast} darkMode={darkMode} cardBg={cardBg} subText={subText} rowBorder={rowBorder} />
      ) : (
        <>
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
            onChange={(e) => {
              userPickedRef.current = true;
              setMethod(e.target.value as MethodSelection);
            }}
            className={`px-3 py-2 text-sm rounded-lg border ${rowBorder} ${cardBg}`}
          >
            {METHOD_OPTIONS.map((o) => {
              const ranking = o.value === 'none' ? undefined : ranked.find((r) => r.method === o.value);
              const suffix = ranking ? accuracyLabel(ranking, anyScored) : '';
              return (
                <option key={o.value} value={o.value}>{o.label}{suffix}</option>
              );
            })}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs uppercase tracking-wide ${subText}`}>Forecast start</span>
          <div className={`inline-flex items-center rounded-lg border overflow-hidden ${rowBorder}`}>
            <button className={toggleBase(false)} onClick={() => stepAnchor(-1)} aria-label="Earlier">‹</button>
            <span className="px-3 py-2 text-sm">{model.anchorMonth}</span>
            <button className={toggleBase(false)} onClick={() => stepAnchor(1)} aria-label="Later">›</button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs uppercase tracking-wide ${subText}`}>Manual overlay</span>
          <select
            value={overlay ? String(overlay.id) : ''}
            onChange={(e) => {
              const id = e.target.value;
              setOverlay(id ? savedForecasts.find((o) => String(o.id) === id) ?? null : null);
            }}
            className={`px-3 py-2 text-sm rounded-lg border ${rowBorder} ${cardBg}`}
          >
            <option value="">None</option>
            {savedForecasts.map((o) => {
              const metricMismatch = o.metric !== metric;
              const basisMismatch = o.basis !== forecast.basis;
              const mismatched = metricMismatch || basisMismatch;
              let title: string | undefined;
              if (metricMismatch) {
                title = `Saved for ${labelForMetric(o.metric)} — switch metric to use it`;
              } else if (basisMismatch) {
                title = `Different basis (${o.basis} vs ${forecast.basis}) — not comparable`;
              }
              return (
                <option
                  key={o.id}
                  value={o.id}
                  disabled={mismatched}
                  title={title}
                >
                  {o.name}
                </option>
              );
            })}
          </select>
        </div>
        <div className={`ml-auto inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
          <button
            onClick={handleExportCsv}
            className={`px-3 py-2 text-sm border-r ${rowBorder} ${cardBg}`}
          >
            CSV
          </button>
          <button
            onClick={handleExportXlsx}
            className={`px-3 py-2 text-sm border-r ${rowBorder} ${cardBg}`}
          >
            XLSX
          </button>
          <button
            onClick={handleExportPdf}
            className={`px-3 py-2 text-sm ${cardBg}`}
          >
            PDF
          </button>
        </div>
      </div>

      <MetricLegend subText={subText} />

      {/* Method note */}
      <div className={`rounded-xl shadow-sm p-4 text-xs ${cardBg} ${subText}`}>
        Projections use the selected model over completed months; seasonality is estimated from up to 24 months of
        history. <strong>CMGR</strong> = the compounded monthly growth rate implied by the projection. Read-only
        estimate — not financial guidance.
      </div>

      <MethodAccuracyStrip
        scores={model.scores}
        selectedMethod={method}
        onPick={(m) => {
          userPickedRef.current = true;
          setMethod(m);
        }}
        subText={subText}
        cardBg={cardBg}
      />

      <div id="forecast-print-region" className="space-y-4">
        <ForecastChart
          model={model}
          darkMode={darkMode}
          cardBg={cardBg}
          subText={subText}
          metricLabel={metricLabel}
          overlayByLabel={overlayByLabel}
        />
        <ForecastTable
          model={model}
          darkMode={darkMode}
          cardBg={cardBg}
          subText={subText}
          rowBorder={rowBorder}
          metricLabel={metricLabel}
        />
        {varianceGroups && (
          <VarianceTable
            groups={varianceGroups}
            darkMode={darkMode}
            cardBg={cardBg}
            subText={subText}
            rowBorder={rowBorder}
            metricLabel={metricLabel}
          />
        )}
      </div>
        </>
      )}
    </div>
  );
}
