import { NextRequest, NextResponse } from 'next/server';
import { fetchNexusExposure, type NexusStateRow } from '@/lib/nexus';
import { csvResponse, xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EXPORT_COLUMNS: ExportColumn[] = [
  { header: 'State', key: 'state' },
  { header: 'Status', key: 'status' },
  { header: 'Registered', key: 'registered' },
  { header: 'Gross Sales (YTD)', key: 'gross_ytd', currency: true },
  { header: 'Transactions (YTD)', key: 'txns_ytd' },
  { header: 'Projected FY Gross', key: 'gross_proj', currency: true },
  { header: 'Projected FY Txns', key: 'txns_proj' },
  { header: 'Sales Threshold', key: 'sales_threshold', currency: true },
  { header: 'Txn Threshold', key: 'txn_threshold' },
  { header: 'Threshold Basis', key: 'basis' },
  { header: 'Prong Rule', key: 'combine' },
  { header: 'Measurement Period', key: 'measurement' },
  { header: 'Over (YTD)', key: 'over_now' },
  { header: 'Over (projected)', key: 'over_proj' },
  { header: 'Notes', key: 'note' },
];

function toExportRow(r: NexusStateRow): Record<string, CellValue> {
  return {
    state: `${r.name} (${r.abbr})`,
    status: r.status,
    registered: r.registered ? 'Yes' : 'No',
    gross_ytd: r.grossYtd,
    txns_ytd: r.txnsYtd,
    gross_proj: r.grossProjected,
    txns_proj: r.txnsProjected,
    sales_threshold: r.salesThreshold,
    txn_threshold: r.txnThreshold,
    basis: r.salesBasis,
    combine: r.combine === 'and' ? 'sales AND txns' : r.combine === 'or' ? 'sales OR txns' : 'sales only',
    measurement: r.measurement,
    over_now: r.overNow ? 'Yes' : 'No',
    over_proj: r.overProjected ? 'Yes' : 'No',
    note: r.note ?? '',
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format') ?? 'json';

    const result = await fetchNexusExposure();

    if (format === 'json') {
      return NextResponse.json(result);
    }

    if (format === 'csv' || format === 'xlsx') {
      const rows = result.rows.map(toExportRow);
      const filename = `nexus-exposure_${result.periodEnd ?? 'na'}`;
      if (format === 'csv') {
        return csvResponse(EXPORT_COLUMNS, rows, filename);
      }
      const note =
        `Economic-nexus exposure — YTD ${result.periodStart ?? 'n/a'} to ${result.periodEnd ?? 'n/a'} ` +
        `(${Math.round(result.yearFraction * 100)}% of year; projection = YTD annualized). ` +
        `Gross-sales basis except FL/MO (taxable). Feed as of ${result.feedAsOf ?? 'n/a'}. ` +
        `Screen for the CPA nexus study — not a filing determination.`;
      return xlsxResponse([{ name: 'Nexus Exposure', columns: EXPORT_COLUMNS, rows }], filename, note);
    }

    return NextResponse.json({ error: `Unknown format: ${format}` }, { status: 400 });
  } catch (error) {
    console.error('Error computing nexus exposure:', error);
    const message = error instanceof Error ? error.message : 'Failed to compute nexus exposure';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
