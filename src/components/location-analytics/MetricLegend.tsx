/** One-line plain-English reference for the three P&L metrics. */
export function MetricLegend({ subText }: { subText: string }) {
  return (
    <p className={`text-xs ${subText}`}>
      <strong>Revenue</strong> = total sales (top line) · <strong>Gross Profit</strong> = revenue − COGS
      (product/materials cost) · <strong>Net Income</strong> = gross profit − payroll &amp; all operating expenses
      (the bottom line).
    </p>
  );
}
