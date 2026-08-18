import { NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { fetchRollbackRows, isPgUndefinedTable } from '@/lib/inventory-rollback';
import type { RollbackResponse } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    // The rollback table is written by a loader phase that may not have run yet —
    // fetchRollbackRows guards on to_regclass so a missing table degrades to an
    // empty result rather than a 500; the as-of page then behaves as it does today.
    const rows = await fetchRollbackRows(getRdsPool());
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
