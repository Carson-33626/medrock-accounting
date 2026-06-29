'use client';

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { LocationAnalyticsRow } from '@/types/location-analytics';
import { chartTheme, usd, usd0 } from './chartTheme';

interface Row {
  location: string;
  'Net Income': number;
}

const POSITIVE = '#059669';
const NEGATIVE = '#dc2626';

export function NetIncomeByLocationChart({
  locations,
  darkMode,
  cardBg,
}: {
  locations: LocationAnalyticsRow[];
  darkMode: boolean;
  cardBg: string;
}) {
  const theme = chartTheme(darkMode);
  const data = useMemo<Row[]>(
    () =>
      locations
        .filter((l) => l.qb)
        .map((l) => ({ location: l.label, 'Net Income': l.qb?.netIncome ?? 0 })),
    [locations],
  );

  if (data.length === 0) return null;

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className="text-sm font-semibold mb-3">Net Income by Location</p>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.gridStroke} />
            <XAxis dataKey="location" tick={{ fontSize: 12 }} stroke={theme.axisStroke} />
            <YAxis
              tickFormatter={(v: number) => usd0.format(v)}
              tick={{ fontSize: 12 }}
              stroke={theme.axisStroke}
              width={90}
            />
            <Tooltip formatter={(v: number | undefined) => usd.format(v ?? 0)} contentStyle={theme.tooltipStyle} />
            <Bar dataKey="Net Income" radius={[4, 4, 0, 0]}>
              {data.map((row) => (
                <Cell key={row.location} fill={row['Net Income'] >= 0 ? POSITIVE : NEGATIVE} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
