'use client';

import { useMemo } from 'react';
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
import type { LocationTrendsResponse } from '@/types/location-analytics';
import { chartTheme, locationColor, usd, usd0 } from './chartTheme';

interface Row {
  month: string;
  [location: string]: string | number;
}

/**
 * Monthly net income per location — grouped bars (one per location) make the
 * within-month comparison easier to read than near-overlapping lines. Same
 * monthly basis as the trend chart.
 */
export function NetIncomeByLocationChart({
  trends,
  darkMode,
  cardBg,
  subText,
}: {
  trends: LocationTrendsResponse;
  darkMode: boolean;
  cardBg: string;
  subText: string;
}) {
  const theme = chartTheme(darkMode);
  const connected = useMemo(() => trends.series.filter((s) => s.connected), [trends]);
  const data = useMemo<Row[]>(
    () =>
      trends.months.map((month, idx) => {
        const row: Row = { month };
        for (const s of connected) row[s.label] = s.points[idx]?.netIncome ?? 0;
        return row;
      }),
    [trends, connected],
  );

  if (data.length === 0 || connected.length === 0) return null;

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className="text-sm font-semibold">Net Income by Location</p>
      <p className={`text-xs mb-3 ${subText}`}>Monthly · QuickBooks</p>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
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
            {connected.map((s) => (
              <Bar key={s.qbLocation} dataKey={s.label} fill={locationColor(s.state)} radius={[4, 4, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
