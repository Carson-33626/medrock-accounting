import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getRdsPool } from '@/lib/rds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface NameRow {
  position_id: string;
  name: string;
}

interface ApiErrorBody {
  error?: string;
}

/**
 * GET /api/payroll/employee-names — { [positionId]: name } for the whole payroll history,
 * so the Mappings tab can show who a position-id employee-map rule refers to.
 *
 * PLAINTEXT ONLY: selects position_id + name (both plaintext columns on
 * source.payroll_history). Never touches sensitive_encrypted, never decrypts, no amounts.
 * Uses each position's most recent name (people can be renamed / re-keyed over time).
 */
export async function GET() {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const { rows } = await getRdsPool().query<NameRow>(
      `SELECT DISTINCT ON (position_id) position_id, name
       FROM source.payroll_history
       WHERE position_id IS NOT NULL AND position_id <> '' AND name IS NOT NULL
       ORDER BY position_id, to_date(pay_date, 'MM/DD/YYYY') DESC`,
    );

    const names: Record<string, string> = {};
    for (const r of rows) names[r.position_id] = r.name;
    return NextResponse.json({ names });
  } catch (error) {
    console.error('[payroll/employee-names GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load employee names';
    const body: ApiErrorBody = { error: message };
    return NextResponse.json(body, { status: 500 });
  }
}
