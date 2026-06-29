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
import type { LocationAnalyticsRow } from '@/types/location-analytics';
import { BRAND_PURPLE, chartTheme, usd, usd0 } from './chartTheme';

interface Row {
  location: string;
  'QB Revenue': number;
  'LifeFile Sales': number;
}

export function RevenueVsLifefileChart({
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
      locations.map((l) => ({
        location: l.label,
        'QB Revenue': l.qb?.revenue ?? 0,
        'LifeFile Sales': l.rds.lifefileSales,
      })),
    [locations],
  );

  if (data.length === 0) return null;

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className="text-sm font-semibold mb-3">QB Revenue vs LifeFile Sales by Location</p>
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
            <Legend />
            <Bar dataKey="QB Revenue" fill="#2563eb" radius={[4, 4, 0, 0]} />
            <Bar dataKey="LifeFile Sales" fill={BRAND_PURPLE} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
