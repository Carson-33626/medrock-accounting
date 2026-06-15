import { NextRequest, NextResponse } from 'next/server';
import { computeTnReturn, fetchTnSourceRows, type TnSourceRow } from '@/lib/sales-tax-tn';
import { buildTnReturnPdf } from '@/lib/sales-tax-pdf';
import { xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import type { TnReturnResponse } from '@/types/sales-tax';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const YEAR_RE = /^\d{4}$/;

function summaryRows(result: TnReturnResponse): Record<string, CellValue>[] {
  const b = result.boxes;
  return [
    { line: 'Line 1', desc: 'Gross Sales', amount: b.grossSales },
    { line: '', desc: 'Exempt / Deductions', amount: b.exemptSales },
    { line: '', desc: 'Taxable Sales', amount: b.taxableSales },
    { line: '', desc: 'Taxable Purchases (use tax)', amount: b.taxablePurchases },
    { line: '', desc: `State Tax (${(b.stateTaxRate * 100).toFixed(2)}%)`, amount: b.stateTaxDue },
    { line: '', desc: `Local Tax (${(b.localTaxRate * 100).toFixed(2)}%)`, amount: b.localTaxDue },
    { line: '', desc: 'Total Tax Due', amount: b.totalTaxDue },
  ];
}

const SUMMARY_COLS: ExportColumn[] = [
  { header: 'Line', key: 'line' },
  { header: 'Description', key: 'desc' },
  { header: 'Amount', key: 'amount', currency: true },
];

const SOURCE_COLS: ExportColumn[] = [
  { header: 'Tx ID', key: 'tx_id' },
  { header: 'Date', key: 'date' },
  { header: 'City', key: 'city' },
  { header: 'County', key: 'county' },
  { header: 'ZIP', key: 'zip' },
  { header: 'Subtotal', key: 'subtotal', currency: true },
  { header: 'Tax', key: 'tax', currency: true },
  { header: 'Total Sales', key: 'total_sales', currency: true },
  { header: 'Taxable Base', key: 'taxable_base', currency: true },
];

function sourceAsRecords(rows: TnSourceRow[]): Record<string, CellValue>[] {
  return rows.map((r) => ({
    tx_id: r.tx_id,
    date: r.date,
    city: r.city,
    county: r.county,
    zip: r.zip,
    subtotal: r.subtotal,
    tax: r.tax,
    total_sales: r.total_sales,
    taxable_base: r.taxable_base,
  }));
}

function csvEscape(v: CellValue): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period');
    if (!period || !YEAR_RE.test(period)) {
      return NextResponse.json({ error: 'period=YYYY is required' }, { status: 400 });
    }

    const tpRaw = searchParams.get('taxablePurchases');
    const taxablePurchases = tpRaw ? Number(tpRaw) : undefined;
    if (taxablePurchases !== undefined && !Number.isFinite(taxablePurchases)) {
      return NextResponse.json({ error: 'taxablePurchases must be a number' }, { status: 400 });
    }

    const result = await computeTnReturn(period, { taxablePurchases });
    const format = searchParams.get('format') ?? 'json';
    if (format === 'json') {
      return NextResponse.json(result);
    }

    const source = await fetchTnSourceRows(period);
    const filename = `${period} - MedRock TN SLS-450 Taxes`;
    const note = `MedRock Tennessee SLS-450 — CY${period} — generated ${new Date().toISOString()} from source.sales_tax_report (feed as of ${result.feedAsOf ?? 'n/a'}). Months: ${result.diagnostics.monthsCovered.join(', ') || 'none'}${result.diagnostics.partialYear ? ' (PARTIAL YEAR)' : ''}. ${result.diagnostics.taxableTransactions} taxable of ${result.diagnostics.totalTransactions} transactions.`;

    if (format === 'xlsx') {
      return xlsxResponse(
        [
          { name: 'SLS-450 Summary', columns: SUMMARY_COLS, rows: summaryRows(result) },
          { name: 'Source Transactions', columns: SOURCE_COLS, rows: sourceAsRecords(source) },
        ],
        filename,
        note,
      );
    }

    if (format === 'csv') {
      const lines: string[] = [];
      lines.push(`# ${note}`);
      lines.push('# === SLS-450 SUMMARY ===');
      lines.push(SUMMARY_COLS.map((c) => csvEscape(c.header)).join(','));
      for (const r of summaryRows(result)) lines.push(SUMMARY_COLS.map((c) => csvEscape(r[c.key] ?? null)).join(','));
      lines.push('');
      lines.push('# === SOURCE TRANSACTIONS ===');
      lines.push(SOURCE_COLS.map((c) => csvEscape(c.header)).join(','));
      for (const r of sourceAsRecords(source)) lines.push(SOURCE_COLS.map((c) => csvEscape(r[c.key] ?? null)).join(','));
      return new NextResponse(lines.join('\r\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}.csv"`,
        },
      });
    }

    if (format === 'pdf') {
      const bytes = await buildTnReturnPdf(result, source);
      return new NextResponse(Buffer.from(bytes), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}.pdf"`,
        },
      });
    }

    return NextResponse.json({ error: `Unknown format: ${format}` }, { status: 400 });
  } catch (error) {
    console.error('Error computing TN return:', error);
    const message = error instanceof Error ? error.message : 'Failed to compute TN return';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
