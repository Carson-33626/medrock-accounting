import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getRdsPool } from '@/lib/rds';
import { loadDraft } from '@/lib/payroll/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One person on the loaded run — enough to pick them for a source drill-down, no amounts. */
export interface RosterItem {
  rowKey: string;
  name: string;
  positionId: string;
  payDate: string;
  payGroup: string;
}

interface ApiErrorBody {
  error?: string;
}

/**
 * GET /api/payroll/roster?headerId= — the people on a run, so the Review drill-down can
 * offer a name picker instead of a raw row_key. Takes `headerId` (same identity ReviewTab
 * holds) and looks the run's pay_date/pay_group up server-side via loadDraft.
 *
 * PLAINTEXT ONLY: selects row_key, position_id, name, pay_date, pay_group — all plaintext
 * columns on source.payroll_history. Never touches sensitive_encrypted, never decrypts,
 * never returns dollar amounts. Mirrors the plaintext discipline of /api/payroll/marketers.
 */
export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const headerIdParam = request.nextUrl.searchParams.get('headerId');
    if (!headerIdParam) {
      return NextResponse.json({ error: 'headerId query param is required' }, { status: 400 });
    }
    const headerId = Number(headerIdParam);
    if (!Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'headerId must be a number' }, { status: 400 });
    }

    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }
    const { header } = loaded;

    const { rows } = await getRdsPool().query<RosterItem>(
      `SELECT DISTINCT ON (ph.row_key)
              ph.row_key AS "rowKey",
              ph.name AS "name",
              ph.position_id AS "positionId",
              ph.pay_date AS "payDate",
              ph.pay_group AS "payGroup"
       FROM source.payroll_history ph
       WHERE ph.pay_date = $1 AND ph.pay_group = $2
       ORDER BY ph.row_key, ph.name`,
      [header.pay_date, header.pay_group],
    );

    // Sort by name for display (DISTINCT ON forced row_key ordering above).
    const result: RosterItem[] = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json(result);
  } catch (error) {
    console.error('[payroll/roster GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load run roster';
    const body: ApiErrorBody = { error: message };
    return NextResponse.json(body, { status: 500 });
  }
}
