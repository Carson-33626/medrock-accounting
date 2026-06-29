/**
 * Shared recharts theming for the Location Analytics charts — keeps axis/grid/
 * tooltip styling and the per-location color map in one place so the chart
 * components stay focused on layout. See
 * docs/superpowers/specs/2026-06-29-location-analytics-trends-charts-design.md
 */

import type { CSSProperties } from 'react';
import type { TrendMetric } from '@/types/location-analytics';

/** Metrics the trend clicker exposes — shared by the line chart, bar chart, and table. */
export const METRIC_OPTIONS: ReadonlyArray<{ key: TrendMetric; label: string }> = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'grossProfit', label: 'Gross Profit' },
  { key: 'netIncome', label: 'Net Income' },
];

/** One month's value per location for the selected metric (recharts row shape). */
export interface TrendRow {
  month: string;
  [location: string]: string | number;
}

export const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** Brand purple used across the app for the secondary (RDS / FIFO) series. */
export const BRAND_PURPLE = '#5e3b8d';

/** Fixed per-location colors so a location keeps its color across every chart. */
export const LOCATION_COLORS: Record<string, string> = {
  FL: '#2563eb', // blue
  TN: '#5e3b8d', // purple
  TX: '#059669', // green
};

export function locationColor(state: string, fallback = '#64748b'): string {
  return LOCATION_COLORS[state] ?? fallback;
}

export interface ChartTheme {
  axisStroke: string;
  gridStroke: string;
  tooltipStyle: CSSProperties | undefined;
}

export function chartTheme(darkMode: boolean): ChartTheme {
  return {
    axisStroke: darkMode ? '#94a3b8' : '#64748b',
    gridStroke: darkMode ? '#334155' : '#e2e8f0',
    tooltipStyle: darkMode
      ? { backgroundColor: '#1e293b', border: '1px solid #334155', color: '#f1f5f9' }
      : undefined,
  };
}
