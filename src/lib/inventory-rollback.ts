/**
 * Shared reader for `inventory.fifo_rollback_valuation` — the rollback (backward) valuation
 * bases shown on the As-of page and folded into the valuation export. Lives here so the
 * /api/inventory/rollback route and the /api/inventory/summary export use the exact same
 * query + missing-table guard (the table is written by a loader phase that may not have run).
 */
import type { Pool } from 'pg';
import type { RollbackValuationRow } from '@/types/inventory';

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

export function isPgUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === UNDEFINED_TABLE
  );
}

/**
 * All rollback valuation rows, ordered by month then location. Returns [] when the table
 * does not exist yet (loader phase not run) — callers degrade exactly as the page does.
 */
export async function fetchRollbackRows(pool: Pool): Promise<RollbackValuationRow[]> {
  const exists = await pool.query<{ regclass: string | null }>(
    `SELECT to_regclass('inventory.fifo_rollback_valuation')::text AS regclass`,
  );
  if (!exists.rows[0]?.regclass) return [];

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
  return result.rows;
}
