import { NextRequest, NextResponse } from 'next/server';
import { xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import { categoryKey, closeDisplayLines, closeJeSheetNote, findCloseHeader } from '@/lib/inventory/monthly-close';
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
  categoryRollForward: [],
  categoryJournalEntries: [],
  categoryUnavailable: null,
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

const CATEGORY_COLUMNS: ExportColumn[] = [
  { header: 'Location', key: 'location' },
  { header: 'Category', key: 'category' },
  { header: 'QB Inventory Account', key: 'inventoryAccount' },
  { header: 'QB COGS Account', key: 'cogsAccount' },
  { header: 'Beginning', key: 'beginning', currency: true },
  { header: 'FIFO Ending (lots)', key: 'fifoTarget', currency: true },
  { header: 'QB Book Balance', key: 'qbBookBalance', currency: true },
  { header: 'Adjustment', key: 'adjustment', currency: true },
  { header: 'Lots', key: 'lotCount' },
  { header: 'Note', key: 'note' },
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

  const beginningByKey = new Map<string, number | null>();
  for (const r of body.categoryRollForward) {
    beginningByKey.set(categoryKey(r.location, r.qbCategory), r.beginning);
  }
  // `.has` rather than a bare `?? null`: a genuine window-start null and a join
  // miss are different facts, and collapsing them makes a future key mismatch
  // silent — the whole Beginning column would just go blank with no signal.
  const beginningFor = (location: string, qbCategory: string): number | null => {
    const key = categoryKey(location, qbCategory);
    if (!beginningByKey.has(key)) {
      console.warn(
        `[inventory/monthly-close] no category roll-forward row for ${location} / ${qbCategory}` +
          ' — Beginning left blank in the export',
      );
      return null;
    }
    return beginningByKey.get(key) ?? null;
  };

  const categoryRows: Record<string, CellValue>[] = body.categoryJournalEntries.flatMap((je) => [
    ...je.lines.map((l) => ({
      location: je.location,
      category: l.qbCategory,
      inventoryAccount: l.inventoryAccount,
      cogsAccount: l.cogsAccount,
      beginning: beginningFor(je.location, l.qbCategory),
      fifoTarget: l.fifoTarget,
      qbBookBalance: l.qbBookBalance,
      adjustment: l.adjustment,
      lotCount: l.lotCount,
      note: l.mapped ? '' : 'residual — no QB category account, needs drug coding',
    })),
    // The figure that actually posts, as a total — a reader should never have to
    // add the category rows up by hand to find the entry they are substantiating.
    {
      location: je.location,
      category: 'TOTAL',
      inventoryAccount: '',
      cogsAccount: '',
      beginning: null,
      fifoTarget: je.fifoTarget,
      qbBookBalance: null,
      adjustment: je.adjustment,
      lotCount: je.lines.reduce((s, l) => s + l.lotCount, 0),
      note: 'categorized total — this is what the draft posts for this location',
    },
  ]);

  const filename = `inventory-close_${month}_${basis}`;
  const packageNote =
    `Monthly Close Package — ${month} (close ${monthEnd}), basis: ${basisLabel}. ` +
    `Generated ${new Date().toISOString()}.`;

  const sheets = [
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
      note:
        `${packageNote} ${closeJeSheetNote(body.journalEntries, body.headers, month)} ` +
        'WHERE NO DRAFT EXISTS these rows are the single-pair BACKWARD-ROLLBACK suggestion ' +
        '(a different valuation method, shown for reference) — the Category-Detail sheet is what ' +
        'the drafts generate from.',
    },
  ];
  if (categoryRows.length > 0) {
    sheets.push({
      name: 'Category-Detail',
      columns: CATEGORY_COLUMNS,
      rows: categoryRows,
      note:
        `${packageNote} Category values are summed from the lot-depletion ledger — this is what the ` +
        'drafts generate from. The Roll-Forward and Journal-Entries sheets are the backward-rollback ' +
        'reconstruction, a different method shown for reference. Unmapped categories (Uncoded, ' +
        'Opening Balance) are listed separately here but post as ONE combined residual line. ' +
        'Drill to individual lots on the Inventory (FIFO) page.',
    });
  }
  return xlsxResponse(sheets, filename, packageNote);
}
