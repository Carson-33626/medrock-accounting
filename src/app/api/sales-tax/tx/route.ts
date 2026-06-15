import { NextRequest, NextResponse } from 'next/server';
import { computeTxReturn, fetchTxSourceRows, getTxReturnConfig, type TxSourceRow } from '@/lib/sales-tax-tx';
import { buildTxReturnPdf } from '@/lib/sales-tax-pdf';
import { xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import type { TxReturnResponse } from '@/types/sales-tax';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PERIOD_RE = /^\d{4}-Q[1-4]$/;

function summaryRows(result: TxReturnResponse): Record<string, CellValue>[] {
  const b = result.boxes;
  const rows: Record<string, CellValue>[] = [
    { line: 'Item 1', desc: 'Total Texas Sales', amount: b.totalTexasSales },
    { line: 'Item 2', desc: 'Taxable Sales', amount: b.taxableSales },
    { line: 'Item 3', desc: 'Taxable Purchases', amount: b.taxablePurchases },
    { line: '', desc: 'Amount Subject to State Tax', amount: b.subjectToStateTax },
    { line: '', desc: `State Tax Due (${(b.stateTaxRate * 100).toFixed(4)}%)`, amount: b.stateTaxDue },
  ];
  for (const l of b.localLines) {
    rows.push({ line: l.code || 'local', desc: `${l.name} (${(l.rate * 100).toFixed(3)}%)`, amount: l.localTaxDue });
  }
  rows.push(
    { line: '', desc: 'Total Local Tax Due', amount: b.totalLocalTaxDue },
    { line: '', desc: 'Total Tax Due', amount: b.totalTaxDue },
    { line: '', desc: 'Timely Filing Discount (0.5%)', amount: -b.timelyFilingDiscount },
    { line: '', desc: 'Net Tax Due', amount: b.netTaxDue },
  );
  return rows;
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
  { header: 'FIPS', key: 'fips' },
  { header: 'ZIP', key: 'zip' },
  { header: 'Subtotal', key: 'subtotal', currency: true },
  { header: 'Tax', key: 'tax', currency: true },
  { header: 'Total Sales', key: 'total_sales', currency: true },
  { header: 'Taxable Base', key: 'taxable_base', currency: true },
];

function sourceAsRecords(rows: TxSourceRow[]): Record<string, CellValue>[] {
  return rows.map((r) => ({
    tx_id: r.tx_id,
    date: r.date,
    city: r.city,
    county: r.county,
    fips: r.fips,
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
    const slug = searchParams.get('slug');
    const period = searchParams.get('period');
    if (!slug || !getTxReturnConfig(slug)) {
      return NextResponse.json({ error: 'unknown Texas return slug' }, { status: 400 });
    }
    if (!period || !PERIOD_RE.test(period)) {
      return NextResponse.json({ error: 'period=YYYY-Qn is required' }, { status: 400 });
    }

    const tpRaw = searchParams.get('taxablePurchases');
    const taxablePurchases = tpRaw ? Number(tpRaw) : undefined;
    if (taxablePurchases !== undefined && !Number.isFinite(taxablePurchases)) {
      return NextResponse.json({ error: 'taxablePurchases must be a number' }, { status: 400 });
    }

    const result = await computeTxReturn(slug, period, { taxablePurchases });
    const format = searchParams.get('format') ?? 'json';
    if (format === 'json') {
      return NextResponse.json(result);
    }

    const source = await fetchTxSourceRows(slug, period);
    const entityShort = result.filing.location.replace('MedRock ', '');
    const filename = `${period.replace('-', '')} - MedRock ${entityShort} TX 01-114 Taxes`;
    const note = `${result.filing.location} Texas Sales & Use Tax (01-114) — ${period} — generated ${new Date().toISOString()} from source.sales_tax_report (feed as of ${result.feedAsOf ?? 'n/a'}). Months: ${result.diagnostics.monthsCovered.join(', ') || 'none'}. ${result.diagnostics.taxableTransactions} taxable of ${result.diagnostics.totalTransactions} transactions.`;

    if (format === 'xlsx') {
      return xlsxResponse(
        [
          { name: 'TX Return Summary', columns: SUMMARY_COLS, rows: summaryRows(result) },
          { name: 'Source Transactions', columns: SOURCE_COLS, rows: sourceAsRecords(source) },
        ],
        filename,
        note,
      );
    }

    if (format === 'csv') {
      const lines: string[] = [];
      lines.push(`# ${note}`);
      lines.push('# === TX RETURN SUMMARY ===');
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
      const bytes = await buildTxReturnPdf(result, source);
      return new NextResponse(Buffer.from(bytes), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}.pdf"`,
        },
      });
    }

    return NextResponse.json({ error: `Unknown format: ${format}` }, { status: 400 });
  } catch (error) {
    console.error('Error computing TX return:', error);
    const message = error instanceof Error ? error.message : 'Failed to compute TX return';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
