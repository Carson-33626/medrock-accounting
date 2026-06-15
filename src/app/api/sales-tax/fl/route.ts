import { NextRequest, NextResponse } from 'next/server';
import { computeFlDr15, fetchFlSourceRows, type FlSourceRow } from '@/lib/sales-tax-fl';
import { buildFlDr15Pdf } from '@/lib/sales-tax-pdf';
import { xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import type { FlDr15Response } from '@/types/sales-tax';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function summaryRows(result: FlDr15Response): Record<string, CellValue>[] {
  const b = result.boxes;
  const i = result.inputs;
  return [
    { line: 'Box 1', desc: 'Gross Sales', amount: b.box1_gross },
    { line: 'Box 2', desc: 'Exempt Sales', amount: b.box2_exempt },
    { line: 'Box 3', desc: 'Total Taxable Amount', amount: b.box3_taxable },
    { line: 'Box 4', desc: 'Total Tax Due', amount: b.box4_tax },
    { line: 'Box B', desc: 'Discretionary Surtax (memo)', amount: b.boxB_surtax },
    { line: 'Box 8a', desc: 'Collection Allowance', amount: b.box8a_allowance },
    { line: '', desc: '', amount: null },
    { line: 'Basis', desc: `Sales basis (${i.salesBasisSource})`, amount: i.salesBasis },
    { line: 'E4', desc: 'Taxable sales (county-rate backout)', amount: i.taxableSales },
    { line: 'F4', desc: 'Tax collected', amount: i.taxCollected },
    { line: 'E7', desc: 'Taxable purchases (use tax)', amount: i.taxablePurchases },
    { line: 'F7', desc: 'Sales/use tax on purchases', amount: i.salesUseTax },
  ];
}

const SUMMARY_COLS: ExportColumn[] = [
  { header: 'DR-15 Line', key: 'line' },
  { header: 'Description', key: 'desc' },
  { header: 'Amount', key: 'amount', currency: true },
];

const SOURCE_COLS: ExportColumn[] = [
  { header: 'Tx ID', key: 'tx_id' },
  { header: 'Date', key: 'date' },
  { header: 'County', key: 'county' },
  { header: 'FIPS', key: 'fips' },
  { header: 'State', key: 'state' },
  { header: 'ZIP', key: 'zip' },
  { header: 'Subtotal', key: 'subtotal', currency: true },
  { header: 'Tax', key: 'tax', currency: true },
  { header: 'Total Sales', key: 'total_sales', currency: true },
  { header: 'Combined Rate', key: 'combined_rate' },
  { header: 'Taxable Base', key: 'taxable_base', currency: true },
];

function sourceAsRecords(rows: FlSourceRow[]): Record<string, CellValue>[] {
  return rows.map((r) => ({
    tx_id: r.tx_id,
    date: r.date,
    county: r.county,
    fips: r.fips,
    state: r.state,
    zip: r.zip,
    subtotal: r.subtotal,
    tax: r.tax,
    total_sales: r.total_sales,
    combined_rate: r.combined_rate ? `${(r.combined_rate * 100).toFixed(2)}%` : '',
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
    const month = searchParams.get('month');
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: 'month=YYYY-MM is required' }, { status: 400 });
    }

    const taxablePurchasesRaw = searchParams.get('taxablePurchases');
    const salesBasisRaw = searchParams.get('salesBasis');
    const taxablePurchases = taxablePurchasesRaw ? Number(taxablePurchasesRaw) : undefined;
    const salesBasisOverride = salesBasisRaw ? Number(salesBasisRaw) : undefined;
    if (taxablePurchases !== undefined && !Number.isFinite(taxablePurchases)) {
      return NextResponse.json({ error: 'taxablePurchases must be a number' }, { status: 400 });
    }
    if (salesBasisOverride !== undefined && !Number.isFinite(salesBasisOverride)) {
      return NextResponse.json({ error: 'salesBasis must be a number' }, { status: 400 });
    }

    const result = await computeFlDr15(month, { taxablePurchases, salesBasisOverride });
    const format = searchParams.get('format') ?? 'json';
    if (format === 'json') {
      return NextResponse.json(result);
    }

    // All file exports carry both the summary and the source data.
    const source = await fetchFlSourceRows(month);
    // Lead with YYYYMM so Windows sorts exports chronologically by name.
    const filename = `${month.replace('-', '')} - MedRock FL DR-15EZ Taxes`;
    const note = `${result.filing.location} ${result.filing.form} (ship-to ${result.filing.filingState}) — ${month} — generated ${new Date().toISOString()} from source.sales_tax_report (feed as of ${result.feedAsOf ?? 'n/a'}). ${result.diagnostics.taxableTransactions} taxable of ${result.diagnostics.totalTransactions} ${result.filing.location} transactions.`;

    if (format === 'xlsx') {
      return xlsxResponse(
        [
          { name: `DR-15 Summary`, columns: SUMMARY_COLS, rows: summaryRows(result) },
          { name: `Source Transactions`, columns: SOURCE_COLS, rows: sourceAsRecords(source) },
        ],
        filename,
        note,
      );
    }

    if (format === 'csv') {
      const lines: string[] = [];
      lines.push(`# ${note}`);
      lines.push('# === DR-15 SUMMARY ===');
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
      const bytes = await buildFlDr15Pdf(result, source);
      return new NextResponse(Buffer.from(bytes), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}.pdf"`,
        },
      });
    }

    return NextResponse.json({ error: `Unknown format: ${format}` }, { status: 400 });
  } catch (error) {
    console.error('Error computing FL DR-15:', error);
    const message = error instanceof Error ? error.message : 'Failed to compute FL DR-15';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
