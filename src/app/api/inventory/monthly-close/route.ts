import { NextRequest, NextResponse } from 'next/server';
import { xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import { closeDisplayLines, closeJeSheetNote, findCloseHeader } from '@/lib/inventory/monthly-close';
import { computeClose, loadStoredDrafts, monthEndDate } from '@/lib/inventory/close-server';
import type { CloseBasis, MonthlyCloseResponse, RollForwardRow } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Postgres error code for "undefined_table". */
const UNDEFINED_TABLE = '42P01';

function isPgUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === UNDEFINED_TABLE
  );
}

const emptyResponse = (month: string, monthEnd: string, basis: CloseBasis): MonthlyCloseResponse => ({
  month,
  monthEnd,
  basis,
  purchasesAvailable: false,
  rollForward: [],
  journalEntries: [],
  headers: [],
  linesById: {},
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const month = searchParams.get('month') ?? '';
    const basis: CloseBasis = searchParams.get('basis') === 'full' ? 'full' : 'floor';
    const format = searchParams.get('format') ?? 'json';

    const monthEnd = monthEndDate(month);
    if (!monthEnd) {
      return NextResponse.json({ error: 'Invalid month; expected YYYY-MM' }, { status: 400 });
    }

    const close = await computeClose(month, basis, monthEnd);
    const stored = await loadStoredDrafts(monthEnd);

    const body: MonthlyCloseResponse = {
      month,
      monthEnd,
      basis,
      ...close,
      ...stored,
    };

    if (format === 'xlsx') return closeWorkbook(body, month, basis, monthEnd);
    return NextResponse.json(body);
  } catch (error) {
    if (isPgUndefinedTable(error)) {
      const month = new URL(request.url).searchParams.get('month') ?? '';
      const monthEnd = monthEndDate(month) ?? month;
      const basis: CloseBasis =
        new URL(request.url).searchParams.get('basis') === 'full' ? 'full' : 'floor';
      return NextResponse.json(emptyResponse(month, monthEnd, basis));
    }
    console.error('Error building inventory monthly close:', error);
    return NextResponse.json({ error: 'Failed to build inventory monthly close' }, { status: 500 });
  }
}

const ROLL_FORWARD_COLUMNS: ExportColumn[] = [
  { header: 'Scope', key: 'scope' },
  { header: 'Beginning', key: 'beginning', currency: true },
  { header: 'Purchases', key: 'purchases', currency: true },
  { header: 'COGS (derived)', key: 'cogs', currency: true },
  { header: 'Ending', key: 'ending', currency: true },
  { header: 'Note', key: 'note' },
];

const JE_COLUMNS: ExportColumn[] = [
  { header: 'Location', key: 'location' },
  { header: 'Account', key: 'account' },
  { header: 'Debit', key: 'debit', currency: true },
  { header: 'Credit', key: 'credit', currency: true },
  { header: 'Memo', key: 'memo' },
];

function rowNote(r: RollForwardRow): string {
  if (r.windowStart) return 'window start (no prior month)';
  if (r.purchasesPending) return 'purchases pending next data-loader run';
  return '';
}

function closeWorkbook(
  body: MonthlyCloseResponse,
  month: string,
  basis: CloseBasis,
  monthEnd: string,
): Promise<NextResponse> {
  const basisLabel = basis === 'floor' ? 'Receipt-priced floor' : 'Full-coverage estimate';

  const rollRows: Record<string, CellValue>[] = body.rollForward.map((r) => ({
    scope: r.cut === 'total' ? 'Total' : r.label,
    beginning: r.beginning,
    purchases: r.purchases,
    cogs: r.cogs,
    ending: r.ending,
    note: rowNote(r),
  }));

  // Same line-selection rule as the UI: stored draft lines when a draft was
  // generated for this month, computed suggestion otherwise.
  const jeRows: Record<string, CellValue>[] = [];
  for (const je of body.journalEntries) {
    const header = findCloseHeader(je.location, body.headers);
    const storedLines = header ? (body.linesById[String(header.id)] ?? []) : [];
    if (!je.bookAvailable && !header) {
      jeRows.push({
        location: je.location,
        account: 'book balance unavailable — reconnect QuickBooks',
        debit: null,
        credit: null,
        memo: '',
      });
      continue;
    }
    const lines = closeDisplayLines(je, header, storedLines, basis, monthEnd);
    if (lines.length === 0) {
      jeRows.push({
        location: je.location,
        account: 'no adjustment (FIFO ties to book)',
        debit: null,
        credit: null,
        memo: '',
      });
      continue;
    }
    lines.forEach((line, idx) => {
      jeRows.push({
        location: idx === 0 ? je.location : '',
        account: line.accountName,
        debit: line.postingType === 'Debit' ? line.amount : null,
        credit: line.postingType === 'Credit' ? line.amount : null,
        memo: line.memo,
      });
    });
  }

  const filename = `inventory-close_${month}_${basis}`;
  const packageNote =
    `Monthly Close Package — ${month} (close ${monthEnd}), basis: ${basisLabel}. ` +
    `Generated ${new Date().toISOString()}.`;

  return xlsxResponse(
    [
      {
        name: 'Roll-Forward',
        columns: ROLL_FORWARD_COLUMNS,
        rows: rollRows,
        note: `${packageNote} COGS is derived (Beginning + Purchases − Ending).`,
      },
      {
        name: 'Journal-Entries',
        columns: JE_COLUMNS,
        rows: jeRows,
        note: `${packageNote} ${closeJeSheetNote(body.journalEntries, body.headers, month)}`,
      },
    ],
    filename,
    packageNote,
  );
}
