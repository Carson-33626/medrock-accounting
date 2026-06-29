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
import { BRAND_PURPLE, chartTheme, usd, usd0 } from './chartTheme';

interface Row {
  month: string;
  'QB Revenue': number;
  'LifeFile Sales': number;
}

/**
 * Monthly QB Revenue vs LifeFile Sales, totaled across all locations — a
 * source cross-check over time (the line chart carries QB only). Same monthly
 * basis as the trend chart.
 */
export function RevenueVsLifefileChart({
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
  const data = useMemo<Row[]>(
    () =>
      trends.months.map((month, idx) => {
        let qb = 0;
        let lifefile = 0;
        for (const s of trends.series) {
          qb += s.points[idx]?.revenue ?? 0;
          lifefile += s.points[idx]?.lifefileSales ?? 0;
        }
        return { month, 'QB Revenue': qb, 'LifeFile Sales': lifefile };
      }),
    [trends],
  );

  if (data.length === 0) return null;

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className="text-sm font-semibold">QB Revenue vs LifeFile Sales</p>
      <p className={`text-xs mb-3 ${subText}`}>Monthly · all locations combined</p>
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
            <Bar dataKey="QB Revenue" fill="#2563eb" radius={[4, 4, 0, 0]} />
            <Bar dataKey="LifeFile Sales" fill={BRAND_PURPLE} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
