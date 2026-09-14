import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { loadDraft, insertAudit } from '@/lib/payroll/store';
import { unpostJournalEntry } from '@/lib/payroll/je-unpost';
import { INV_OPEN_PAY_GROUP, INV_CLOSE_PAY_GROUP } from '@/lib/inventory/monthly-close';
import { LAB_ACCRUAL_PAY_GROUP } from '@/lib/inventory/lab-supplies-je';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// A QuickBooks read, up to a few attachment deletes, and the entry delete.
export const maxDuration = 60;

interface UnpostRequestBody {
  headerId: number;
  /** Free text from the reviewer — lands in the audit row so the undo explains itself. */
  reason?: string;
}

/**
 * POST /api/inventory/monthly-close/unpost { headerId, reason } — delete a POSTED
 * inventory entry (monthly close, the year-end correction, or a legacy lab pair)
 * from QuickBooks and return its header to needs_review so it can be regenerated
 * and reposted. Carson, 2026-09-14: "an undo / pull down button to delete the
 * posted journal so we can regenerate and repost it."
 *
 * Gates mirror the post route: wrong kind → 400; not posted → 409. Every attempt,
 * blocked or done, is audited. QuickBooks is deleted from FIRST; local state only
 * changes after QuickBooks confirms (see je-unpost.ts).
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
    const inventoryGroup =
      header.pay_group === INV_CLOSE_PAY_GROUP ||
      header.pay_group === INV_OPEN_PAY_GROUP ||
      header.pay_group === LAB_ACCRUAL_PAY_GROUP;
    if (!inventoryGroup) {
      return NextResponse.json({ error: 'header is not an inventory entry' }, { status: 400 });
    }
    if (header.status !== 'posted' || !header.qb_entry_id) {
      await insertAudit({ headerId, mode: 'live', entity: header.entity, outcome: 'blocked', reason: 'unpost: not posted' });
      return NextResponse.json({ error: 'entry is not posted — nothing to pull back' }, { status: 409 });
    }

    const reason =
      (body.reason ?? '').trim() ||
      'Pulled back from QuickBooks from the Inventory Close tab to regenerate and repost';
    const outcome = await unpostJournalEntry(header, reason);
    return NextResponse.json({ ok: true, ...outcome });
  } catch (error) {
    console.error('[inventory/monthly-close/unpost POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to pull the entry back from QuickBooks';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
