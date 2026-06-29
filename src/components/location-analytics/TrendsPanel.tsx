'use client';

import { useMemo, useState } from 'react';
import type { LocationTrendsResponse, TrendMetric } from '@/types/location-analytics';
import { METRIC_OPTIONS, type TrendRow } from './chartTheme';
import { MetricLegend } from './MetricLegend';
import { TrendLineChart } from './TrendLineChart';
import { TrendBarChart } from './TrendBarChart';
import { TrendTable } from './TrendTable';

/**
 * Trends & Charts tab body. Owns the single metric clicker (Revenue / Gross
 * Profit / Net Income) that drives the line chart, the monthly bar chart, and
 * the inspection table — all from one reshaped monthly dataset.
 */
export function TrendsPanel({
  trends,
  darkMode,
  cardBg,
  subText,
  rowBorder,
}: {
  trends: LocationTrendsResponse;
  darkMode: boolean;
  cardBg: string;
  subText: string;
  rowBorder: string;
}) {
  const [metric, setMetric] = useState<TrendMetric>('revenue');
  const metricLabel = METRIC_OPTIONS.find((m) => m.key === metric)?.label ?? '';

  // Reshape once: one row per month, a column per location for the chosen metric.
  const rows = useMemo<TrendRow[]>(
    () =>
      trends.months.map((month, idx) => {
        const row: TrendRow = { month };
        for (const s of trends.series) row[s.label] = s.points[idx]?.[metric] ?? 0;
        return row;
      }),
    [trends, metric],
  );

  return (
    <div className="space-y-4">
      {/* Shared metric clicker */}
      <div className="flex items-center gap-3">
        <span className={`text-xs uppercase tracking-wide ${subText}`}>Metric</span>
        <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
          {METRIC_OPTIONS.map((m) => (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                metric === m.key ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
              }`}
              style={metric === m.key ? { backgroundColor: '#5e3b8d' } : undefined}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <MetricLegend subText={subText} />

      <TrendLineChart
        rows={rows}
        series={trends.series}
        metricLabel={metricLabel}
        darkMode={darkMode}
        cardBg={cardBg}
        subText={subText}
      />
      <TrendBarChart
        rows={rows}
        series={trends.series}
        metricLabel={metricLabel}
        darkMode={darkMode}
        cardBg={cardBg}
        subText={subText}
      />
      <TrendTable
        rows={rows}
        series={trends.series}
        metricLabel={metricLabel}
        darkMode={darkMode}
        cardBg={cardBg}
        subText={subText}
        rowBorder={rowBorder}
      />
    </div>
  );
}
