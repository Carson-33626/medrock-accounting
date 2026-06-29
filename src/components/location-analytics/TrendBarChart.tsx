'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { LocationTrendSeries } from '@/types/location-analytics';
import { chartTheme, locationColor, usd, usd0, type TrendRow } from './chartTheme';

/**
 * Monthly grouped bars (one bar per location, per month) for the metric chosen
 * in TrendsPanel — the discrete-comparison companion to the trend lines.
 */
export function TrendBarChart({
  rows,
  series,
  metricLabel,
  darkMode,
  cardBg,
  subText,
}: {
  rows: TrendRow[];
  series: LocationTrendSeries[];
  metricLabel: string;
  darkMode: boolean;
  cardBg: string;
  subText: string;
}) {
  const theme = chartTheme(darkMode);

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className="text-sm font-semibold">{metricLabel} by month</p>
      <p className={`text-xs mb-3 ${subText}`}>Monthly breakdown by location</p>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.gridStroke} />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke={theme.axisStroke} />
            <YAxis
              tickFormatter={(v: number) => usd0.format(v)}
              tick={{ fontSize: 12 }}
              stroke={theme.axisStroke}
              width={90}
            />
            <Tooltip formatter={(v: number | undefined) => usd.format(v ?? 0)} contentStyle={theme.tooltipStyle} />
            <Legend />
            {series.map((s) => (
              <Bar key={s.qbLocation} dataKey={s.label} fill={locationColor(s.state)} radius={[4, 4, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
