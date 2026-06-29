'use client';

import { useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { LocationTrendsResponse, TrendMetric } from '@/types/location-analytics';
import { chartTheme, locationColor, usd, usd0 } from './chartTheme';

const METRICS: ReadonlyArray<{ key: TrendMetric; label: string }> = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'grossProfit', label: 'Gross Profit' },
  { key: 'netIncome', label: 'Net Income' },
];

interface TrendRow {
  month: string;
  [location: string]: string | number;
}

export function TrendLineChart({
  trends,
  darkMode,
  cardBg,
}: {
  trends: LocationTrendsResponse;
  darkMode: boolean;
  cardBg: string;
}) {
  const [metric, setMetric] = useState<TrendMetric>('revenue');
  const theme = chartTheme(darkMode);

  // Reshape series → one row per month with a column per location.
  const data = useMemo<TrendRow[]>(() => {
    return trends.months.map((month, idx) => {
      const row: TrendRow = { month };
      for (const s of trends.series) {
        row[s.label] = s.points[idx]?.[metric] ?? 0;
      }
      return row;
    });
  }, [trends, metric]);

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
        <p className="text-sm font-semibold">{METRICS.find((m) => m.key === metric)?.label} over time</p>
        <div className="inline-flex rounded-lg border border-slate-300 dark:border-slate-600 overflow-hidden">
          {METRICS.map((m) => (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                metric === m.key ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
              }`}
              style={metric === m.key ? { backgroundColor: '#5e3b8d' } : undefined}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.gridStroke} />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke={theme.axisStroke} />
            <YAxis
              tickFormatter={(v: number) => usd0.format(v)}
              tick={{ fontSize: 12 }}
              stroke={theme.axisStroke}
              width={90}
            />
            <Tooltip
              formatter={(v: number | undefined) => usd.format(v ?? 0)}
              contentStyle={theme.tooltipStyle}
            />
            <Legend />
            {trends.series.map((s) => (
              <Line
                key={s.qbLocation}
                type="monotone"
                dataKey={s.label}
                stroke={locationColor(s.state)}
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 5 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
