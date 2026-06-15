import { NextRequest, NextResponse } from 'next/server';
import { computeFlDr15 } from '@/lib/sales-tax-fl';
import { xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

    if (searchParams.get('format') === 'xlsx') {
      const b = result.boxes;
      const i = result.inputs;
      const columns: ExportColumn[] = [
        { header: 'DR-15 Line', key: 'line' },
        { header: 'Description', key: 'desc' },
        { header: 'Amount', key: 'amount', currency: true },
      ];
      const rows: Record<string, CellValue>[] = [
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
      const note = `MedRock FL DR-15 — ${month} — generated ${new Date().toISOString()} from source.sales_tax_report (feed as of ${result.feedAsOf ?? 'n/a'}). ${result.diagnostics.taxableTransactions} taxable of ${result.diagnostics.totalTransactions} FL transactions.`;
      return xlsxResponse([{ name: `DR-15 ${month}`, columns, rows }], `MedRock-FL-DR15_${month}`, note);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error computing FL DR-15:', error);
    const message = error instanceof Error ? error.message : 'Failed to compute FL DR-15';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
