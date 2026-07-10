import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { setHeaderStatus } from '@/lib/payroll/store';

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
  // requireAuth redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAuth();

  try {
    const body = (await request.json()) as ApproveRequestBody;
    const { headerId } = body;
    if (typeof headerId !== 'number' || !Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'headerId is required' }, { status: 400 });
    }

    await setHeaderStatus(headerId, 'approved');
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[payroll/approve POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to approve payroll draft';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
