import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { loadDraft, listSiblings, setHeadersStatus } from '@/lib/payroll/store';
import { isPayrollPeriodComplete, PERIOD_COMPLETE_MESSAGE } from '@/lib/payroll/period-locks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ApproveRequestBody {
  headerId: number;
}

/**
 * POST /api/payroll/approve { headerId } — mark a draft 'approved'. This is a required
 * step before a live QuickBooks post (see the `decidePost` gate in /api/payroll/post),
 * but approval alone never posts anything — it only flips the header's status.
 */
export async function POST(request: NextRequest) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();

  try {
    const body = (await request.json()) as ApproveRequestBody;
    const { headerId } = body;
    if (typeof headerId !== 'number' || !Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'headerId is required' }, { status: 400 });
    }

    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }
    // Closed period: approval's only purpose is unlocking a post, and posting a
    // pre-04/10/2026 payroll would duplicate what accounting already booked.
    //
    // A PAYROLL lock, so it applies to payroll runs only. Inventory entries (the
    // 12/31/2025 year-end correction, the monthly closes) and the accrual pairs are
    // dated by their own period and are exactly what accounting asked this system to
    // post — Carson, 2026-09-14, was blocked approving the year-end correction because
    // its 12/31/2025 pay_date fell before the payroll cutoff. They post through their
    // own routes, which carry their own gates.
    if (loaded.header.kind === 'pay_date' && isPayrollPeriodComplete(loaded.header.pay_date)) {
      return NextResponse.json({ error: PERIOD_COMPLETE_MESSAGE }, { status: 409 });
    }

    const siblings = await listSiblings(loaded.header.entity, loaded.header.pay_date, loaded.header.pay_group);
    // A split run is approved as a PAIR — a lone approved half could then post alone and
    // misstate two months. setHeadersStatus is one UPDATE (atomic) and skips posted rows.
    await setHeadersStatus(siblings.map((s) => s.id), 'approved');
    return NextResponse.json({ ok: true, approvedIds: siblings.map((s) => s.id) });
  } catch (error) {
    console.error('[payroll/approve POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to approve payroll draft';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
