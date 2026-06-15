import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { computeLocationAnalytics } from '@/lib/location-analytics';
import { csvResponse, xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import type { Basis } from '@/types/location-analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXPORT_COLUMNS: ExportColumn[] = [
  { header: 'Location', key: 'location' },
  { header: 'QB Connected', key: 'connected' },
  { header: 'QB Revenue', key: 'revenue', currency: true },
  { header: 'LifeFile Sales', key: 'lifefileSales', currency: true },
  { header: 'Revenue Variance', key: 'revenueVariance', currency: true },
  { header: 'Revenue Variance %', key: 'revenueVariancePercent' },
  { header: 'QB COGS', key: 'cogs', currency: true },
  { header: 'FIFO COGS', key: 'fifoCogs', currency: true },
  { header: 'COGS Variance', key: 'cogsVariance', currency: true },
  { header: 'COGS Variance %', key: 'cogsVariancePercent' },
  { header: 'Gross Profit', key: 'grossProfit', currency: true },
  { header: 'Payroll', key: 'payrollTotal', currency: true },
  { header: 'Operating Expenses', key: 'operatingExpensesTotal', currency: true },
  { header: 'Net Income', key: 'netIncome', currency: true },
  { header: 'On-Hand Inventory (FIFO)', key: 'onHandInventory', currency: true },
];

export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const sp = request.nextUrl.searchParams;
    const startDate = sp.get('startDate');
    const endDate = sp.get('endDate');
    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: 'Missing required parameters: startDate, endDate' },
        { status: 400 },
      );
    }
    const basis: Basis = sp.get('basis') === 'Accrual' ? 'Accrual' : 'Cash';
    const thresholdRaw = parseFloat(sp.get('threshold') ?? '5');
    const thresholdPercent = Number.isFinite(thresholdRaw) ? thresholdRaw : 5;
    const format = sp.get('format') ?? 'json';

    const data = await computeLocationAnalytics({ startDate, endDate, basis, thresholdPercent });

    if (format === 'csv' || format === 'xlsx') {
      const rows: Record<string, CellValue>[] = data.locations.map((r) => ({
        location: r.label,
        connected: r.connected ? 'Yes' : 'No',
        revenue: r.qb?.revenue ?? null,
        lifefileSales: r.rds.lifefileSales,
        revenueVariance: r.reconciliation?.revenueVariance ?? null,
        revenueVariancePercent: r.reconciliation?.revenueVariancePercent ?? null,
        cogs: r.qb?.cogs ?? null,
        fifoCogs: r.rds.fifoCogs,
        cogsVariance: r.reconciliation?.cogsVariance ?? null,
        cogsVariancePercent: r.reconciliation?.cogsVariancePercent ?? null,
        grossProfit: r.qb?.grossProfit ?? null,
        payrollTotal: r.qb?.payrollTotal ?? null,
        operatingExpensesTotal: r.qb?.operatingExpensesTotal ?? null,
        netIncome: r.qb?.netIncome ?? null,
        onHandInventory: r.rds.onHandInventory,
      }));
      rows.push({
        location: 'TOTAL',
        connected: '',
        revenue: data.totals.revenue,
        lifefileSales: data.totals.lifefileSales,
        revenueVariance: null,
        revenueVariancePercent: null,
        cogs: data.totals.cogs,
        fifoCogs: data.totals.fifoCogs,
        cogsVariance: null,
        cogsVariancePercent: null,
        grossProfit: data.totals.grossProfit,
        payrollTotal: data.totals.payrollTotal,
        operatingExpensesTotal: data.totals.operatingExpensesTotal,
        netIncome: data.totals.netIncome,
        onHandInventory: data.totals.onHandInventory,
      });

      const filename = `location-analytics_${startDate}_to_${endDate}_${basis}`;
      if (format === 'csv') {
        return csvResponse(EXPORT_COLUMNS, rows, filename);
      }
      const note = `Location Analytics — ${startDate} to ${endDate}, ${basis} basis. QB P&L vs LifeFile dispensing sales (Σ Subtotal) and FIFO COGS. Read-only cross-check. Generated ${data.generatedAt}.`;
      return xlsxResponse([{ name: 'Location Analytics', columns: EXPORT_COLUMNS, rows }], filename, note);
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('[Location Analytics] API error:', error);
    const message = error instanceof Error ? error.message : 'Failed to fetch location analytics';
    if (message.includes('rate limit')) {
      return NextResponse.json({ error: message }, { status: 429 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
