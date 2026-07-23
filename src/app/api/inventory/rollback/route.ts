import { NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import type { RollbackResponse, RollbackValuationRow } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RollbackQueryRow {
  as_of_month: string;
  location: string;
  value_floor: number | null;
  value_full: number | null;
  on_hand_qty: number | null;
  uncosted_qty: number | null;
  lambda_config: string | null;
  fit_month: string | null;
  test_month: string | null;
  oos_ratio: number | null;
}

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

export async function GET() {
  try {
    const pool = getRdsPool();

    // The rollback table is written by a loader phase that may not have run yet.
    // Guard on to_regclass so a missing table degrades to an empty result rather
    // than a 500 — the as-of page then behaves exactly as it does today.
    const exists = await pool.query<{ regclass: string | null }>(
      `SELECT to_regclass('inventory.fifo_rollback_valuation')::text AS regclass`,
    );
    if (!exists.rows[0]?.regclass) {
      const empty: RollbackResponse = { rows: [] };
      return NextResponse.json(empty);
    }

    const result = await pool.query<RollbackQueryRow>(
      `SELECT as_of_month, location,
              value_floor::float8  AS value_floor,
              value_full::float8   AS value_full,
              on_hand_qty::float8  AS on_hand_qty,
              uncosted_qty::float8 AS uncosted_qty,
              lambda_config,
              fit_month,
              test_month,
              oos_ratio::float8    AS oos_ratio
       FROM inventory.fifo_rollback_valuation
       ORDER BY as_of_month, location`,
    );

    const rows: RollbackValuationRow[] = result.rows;
    const body: RollbackResponse = { rows };
    return NextResponse.json(body);
  } catch (error) {
    // Belt-and-suspenders: if the table vanished between the to_regclass check
    // and the select (or the guard was ever removed), treat undefined_table as
    // "no data" so the page stays functional.
    if (isPgUndefinedTable(error)) {
      const empty: RollbackResponse = { rows: [] };
      return NextResponse.json(empty);
    }
    console.error('Error fetching inventory rollback valuation:', error);
    return NextResponse.json({ error: 'Failed to load inventory rollback valuation' }, { status: 500 });
  }
}
