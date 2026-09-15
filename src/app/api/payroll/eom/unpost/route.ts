import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { loadDraft, insertAudit } from '@/lib/payroll/store';
import { unpostJournalEntry } from '@/lib/payroll/je-unpost';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// A QuickBooks read, up to a few attachment deletes, and the entry delete.
export const maxDuration = 60;

interface UnpostRequestBody {
  headerId: number;
  /** Free text from the reviewer — lands in the audit row so the undo explains itself. */
  reason?: string;
}

/** The pay groups this route may pull back: the month-end pool entries and the
 *  CS-only catch-up entries (plus their top-ups, 'CS ALLO 2', ...). */
export function isAllocationPayGroup(payGroup: string): boolean {
  return payGroup === 'EOM' || payGroup.startsWith('CS ALLO');
}

/**
 * POST /api/payroll/eom/unpost { headerId, reason } — delete a POSTED allocation
 * entry (a month-end `% Allo` or a `CS Allo` catch-up) from QuickBooks and return
 * its header to needs_review. Carson, 2026-09-15: "for those CS allo posting, i do
 * not see a pull back button option, please add that."
 *
 * Same shape as /api/inventory/monthly-close/unpost: wrong kind → 400; not posted
 * → 409. Every attempt is audited. QuickBooks is deleted from FIRST; local state
 * only changes after QuickBooks confirms (see je-unpost.ts). Once a CS Allo is
 * pulled back, listPostedCsAlloHeaders no longer sees it, so the month's pool
 * re-admits Customer Service on the next Generate — that is the point.
 */
export async function POST(request: NextRequest) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();

  let headerId: number | null = null;
  try {
    const body = (await request.json()) as UnpostRequestBody;
    headerId = body.headerId;
    if (typeof headerId !== 'number' || !Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'headerId is required' }, { status: 400 });
    }
    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }
    const { header } = loaded;
    if (header.kind !== 'allocation' || !isAllocationPayGroup(header.pay_group)) {
      return NextResponse.json({ error: 'header is not an allocation entry' }, { status: 400 });
    }
    if (header.status !== 'posted' || !header.qb_entry_id) {
      await insertAudit({ headerId, mode: 'live', entity: header.entity, outcome: 'blocked', reason: 'unpost: not posted' });
      return NextResponse.json({ error: 'entry is not posted — nothing to pull back' }, { status: 409 });
    }

    const reason =
      (body.reason ?? '').trim() ||
      'Pulled back from QuickBooks from the End of Month tab to regenerate and repost';
    const outcome = await unpostJournalEntry(header, reason);
    return NextResponse.json({ ok: true, ...outcome });
  } catch (error) {
    console.error('[payroll/eom/unpost POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to pull the entry back from QuickBooks';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
