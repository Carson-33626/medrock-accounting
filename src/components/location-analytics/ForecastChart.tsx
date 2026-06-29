'use client';

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
import { chartTheme, locationColor, usd, usd0 } from './chartTheme';
import type { ForecastModel } from './forecastModel';

type Row = { month: string } & Record<string, string | number | null>;

/** Solid actual line + dashed projected line per location (shared color). */
export function ForecastChart({
  model,
  darkMode,
  cardBg,
  subText,
  metricLabel,
}: {
  model: ForecastModel;
  darkMode: boolean;
  cardBg: string;
  subText: string;
  metricLabel: string;
}) {
  const theme = chartTheme(darkMode);

  const rows: Row[] = model.allMonths.map((month) => {
    const row: Row = { month };
    for (const loc of model.locations) {
      // Actual line: completed months only (current partial omitted to avoid a false dip).
      row[loc.label] = month in loc.actual && month !== model.currentMonthKey ? loc.actual[month] : null;
      // Forecast line: connect from last actual, through the current-month estimate, into the future.
      let f: number | null = null;
      if (month === loc.lastCompletedMonth) f = loc.connectValue;
      else if (month === model.currentMonthKey) f = loc.estCurrent;
      else if (month in loc.future) f = loc.future[month];
      row[`${loc.label} (forecast)`] = f;
    }
    return row;
  });

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className="text-sm font-semibold">{metricLabel} forecast</p>
      <p className={`text-xs mb-3 ${subText}`}>Solid = actual · dashed = projected</p>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.gridStroke} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke={theme.axisStroke} />
            <YAxis
              tickFormatter={(v: number) => usd0.format(v)}
              tick={{ fontSize: 12 }}
              stroke={theme.axisStroke}
              width={90}
            />
            <Tooltip formatter={(v: number | undefined) => usd.format(v ?? 0)} contentStyle={theme.tooltipStyle} />
            <Legend />
            {model.locations.flatMap((loc) => [
              <Line
                key={loc.qbLocation}
                type="monotone"
                dataKey={loc.label}
                stroke={locationColor(loc.state)}
                strokeWidth={2}
                dot={false}
                connectNulls
              />,
              <Line
                key={`${loc.qbLocation}-f`}
                type="monotone"
                dataKey={`${loc.label} (forecast)`}
                stroke={locationColor(loc.state)}
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                legendType="none"
                connectNulls
              />,
            ])}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
