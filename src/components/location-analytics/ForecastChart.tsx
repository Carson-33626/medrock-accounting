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
  ReferenceLine,
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
  overlayByLabel,
}: {
  model: ForecastModel;
  darkMode: boolean;
  cardBg: string;
  subText: string;
  metricLabel: string;
  /** Manual-overlay values, month ('YYYY-MM') → amount, keyed by location label. Renders a
   * third dotted series per location when provided — see `ForecastPanel`'s overlay selector. */
  overlayByLabel?: Record<string, Record<string, number>>;
}) {
  const theme = chartTheme(darkMode);

  const lastCompleteMonth = model.completedMonths[model.completedMonths.length - 1];
  const hasHoldOut =
    model.provisionalMonths.length > 0 &&
    lastCompleteMonth !== undefined &&
    model.anchorMonth < lastCompleteMonth;

  const provisionalSet = new Set(model.provisionalMonths);
  const rows: Row[] = model.allMonths.map((month) => {
    const row: Row = { month };
    for (const loc of model.locations) {
      // Actual line: fully-closed completed months only (provisional/current omitted to avoid a false spike).
      row[loc.label] = month in loc.actual && !provisionalSet.has(month) ? loc.actual[month] : null;
      // Forecast line: connect from last trained actual, through provisional + current estimates, into the future.
      let f: number | null = null;
      if (month === loc.lastTrainMonth) f = loc.connectValue;
      else if (provisionalSet.has(month)) f = loc.est[month] ?? null;
      else if (month in loc.future) f = loc.future[month];
      row[`${loc.label} (forecast)`] = f;
      row[`${loc.label} (manual)`] = overlayByLabel?.[loc.label]?.[month] ?? null;
    }
    return row;
  });

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className="text-sm font-semibold">{metricLabel} forecast</p>
      <p className={`text-xs mb-3 ${subText}`}>
        Solid = actual · dashed = projected{overlayByLabel ? ' · dotted = manual overlay' : ''}
      </p>
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
            {hasHoldOut && (
              <ReferenceLine
                x={model.anchorMonth}
                stroke={theme.axisStroke}
                strokeDasharray="2 2"
                label={{ value: 'forecast start', fontSize: 10 }}
              />
            )}
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
              ...(model.showProjection
                ? [
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
                  ]
                : []),
              ...(overlayByLabel
                ? [
                    <Line
                      key={`${loc.qbLocation}-manual`}
                      type="monotone"
                      dataKey={`${loc.label} (manual)`}
                      stroke={locationColor(loc.state)}
                      strokeWidth={1.5}
                      strokeDasharray="2 2"
                      dot={{ r: 2 }}
                      legendType="none"
                      connectNulls
                    />,
                  ]
                : []),
            ])}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
