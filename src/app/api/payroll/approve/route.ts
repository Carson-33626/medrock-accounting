import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { loadDraft, listSiblings, setHeadersStatus } from '@/lib/payroll/store';

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
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

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
