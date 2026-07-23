import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import {
  buildRollForward,
  buildLocationJE,
  journalEntryLines,
  type RollbackMonthValue,
} from '@/lib/inventory/monthly-close';
import {
  getBalanceSheetInventory,
  LOCATION_MAPPING,
  type Location,
} from '@/lib/quickbooks-multi';
import type {
  CloseBasis,
  LocationJE,
  MonthlyCloseResponse,
  RollForwardRow,
} from '@/types/inventory';

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

interface RollbackCloseRow {
  as_of_month: string;
  location: string;
  value_floor: number | null;
  value_full: number | null;
  purchases_floor: number | null;
  purchases_full: number | null;
}

/** 'YYYY-MM' → last day of that month as 'YYYY-MM-DD', or null when malformed. */
function monthEndDate(month: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const mon = parseInt(m[2], 10); // 1..12
  if (mon < 1 || mon > 12) return null;
  const last = new Date(Date.UTC(year, mon, 0));
  return last.toISOString().slice(0, 10);
}

function isKnownLocation(location: string): location is Location {
  return Object.prototype.hasOwnProperty.call(LOCATION_MAPPING, location);
}

function toMonthValue(r: RollbackCloseRow): RollbackMonthValue {
  return {
    location: r.location,
    valueFloor: r.value_floor,
    valueFull: r.value_full,
    purchasesFloor: r.purchases_floor,
    purchasesFull: r.purchases_full,
  };
}

const emptyResponse = (month: string, monthEnd: string, basis: CloseBasis): MonthlyCloseResponse => ({
  month,
  monthEnd,
  basis,
  purchasesAvailable: false,
  rollForward: [],
  journalEntries: [],
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

    const pool = getRdsPool();

    // The rollback table is written by a loader phase that may not have run yet.
    // Guard on to_regclass so a missing table degrades to an empty close.
    const exists = await pool.query<{ regclass: string | null }>(
      `SELECT to_regclass('inventory.fifo_rollback_valuation')::text AS regclass`,
    );
    if (!exists.rows[0]?.regclass) {
      return NextResponse.json(emptyResponse(month, monthEnd, basis));
    }

    // The purchases_floor / purchases_full columns were just added to the loader
    // and may not exist (or be NULL) until the next nightly run. Probe column
    // existence; when absent, select NULL so the query never 42703s and the
    // roll-forward degrades to "purchases pending".
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'inventory' AND table_name = 'fifo_rollback_valuation'
         AND column_name IN ('purchases_floor', 'purchases_full')`,
    );
    const colNames = new Set(cols.rows.map((c) => c.column_name));
    const purchasesAvailable = colNames.has('purchases_floor') && colNames.has('purchases_full');
    const purchasesFloorExpr = purchasesAvailable
      ? 'purchases_floor::float8'
      : 'NULL::float8';
    const purchasesFullExpr = purchasesAvailable ? 'purchases_full::float8' : 'NULL::float8';

    // Beginning = the immediately-prior month present in the table (not merely
    // the previous calendar month — a gap month has no beginning of its own).
    const priorRes = await pool.query<{ as_of_month: string }>(
      `SELECT as_of_month FROM inventory.fifo_rollback_valuation
       WHERE as_of_month < $1
       ORDER BY as_of_month DESC
       LIMIT 1`,
      [month],
    );
    const priorMonth = priorRes.rows[0]?.as_of_month ?? null;

    const months = priorMonth ? [month, priorMonth] : [month];
    const result = await pool.query<RollbackCloseRow>(
      `SELECT as_of_month, location,
              value_floor::float8 AS value_floor,
              value_full::float8  AS value_full,
              ${purchasesFloorExpr} AS purchases_floor,
              ${purchasesFullExpr}  AS purchases_full
       FROM inventory.fifo_rollback_valuation
       WHERE as_of_month = ANY($1)
       ORDER BY as_of_month, location`,
      [months],
    );

    const currentRows = result.rows
      .filter((r) => r.as_of_month === month)
      .map(toMonthValue);
    const priorRows = priorMonth
      ? result.rows.filter((r) => r.as_of_month === priorMonth).map(toMonthValue)
      : null;

    if (currentRows.length === 0) {
      // No rollback rows for this month → nothing to close.
      const empty = emptyResponse(month, monthEnd, basis);
      empty.purchasesAvailable = purchasesAvailable;
      if (format === 'xlsx') return closeWorkbook(empty, month, basis, monthEnd);
      return NextResponse.json(empty);
    }

    const rollForward = buildRollForward(currentRows, priorRows, basis, purchasesAvailable);

    // Suggested JE per location: FIFO target (this basis Ending) vs QB book
    // balance. Fetch each realm independently and tolerate per-location failure.
    const locationRows = rollForward.filter((r) => r.cut === 'location');
    const journalEntries: LocationJE[] = await Promise.all(
      locationRows.map(async (row) => {
        const fifoTarget = row.ending;
        if (!isKnownLocation(row.label)) {
          return buildLocationJE(row.label, fifoTarget, null, []);
        }
        const book = await getBalanceSheetInventory(row.label, monthEnd);
        return buildLocationJE(row.label, fifoTarget, book?.total ?? null, book?.accounts ?? []);
      }),
    );

    const body: MonthlyCloseResponse = {
      month,
      monthEnd,
      basis,
      purchasesAvailable,
      rollForward,
      journalEntries,
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

  const jeRows: Record<string, CellValue>[] = [];
  for (const je of body.journalEntries) {
    if (!je.bookAvailable) {
      jeRows.push({
        location: je.location,
        account: 'book balance unavailable — reconnect QuickBooks',
        debit: null,
        credit: null,
        memo: '',
      });
      continue;
    }
    const lines = journalEntryLines(je, basis, monthEnd);
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
        account: line.account,
        debit: line.debit,
        credit: line.credit,
        memo: line.memo,
      });
    });
  }

  const filename = `inventory-close_${month}_${basis}`;
  const note =
    `Monthly Close Package — ${month} (close ${monthEnd}), basis: ${basisLabel}. ` +
    `COGS is derived (Beginning + Purchases − Ending). Journal entries are SUGGESTED ONLY — ` +
    `nothing is posted to QuickBooks. Generated ${new Date().toISOString()}.`;

  return xlsxResponse(
    [
      { name: 'Roll-Forward', columns: ROLL_FORWARD_COLUMNS, rows: rollRows },
      { name: 'Journal-Entries', columns: JE_COLUMNS, rows: jeRows },
    ],
    filename,
    note,
  );
}
