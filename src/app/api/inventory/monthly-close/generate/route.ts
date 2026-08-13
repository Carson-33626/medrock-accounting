import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { generateInvCloseDrafts, loadStoredDrafts, monthEndDate } from '@/lib/inventory/close-server';
import type { CloseBasis } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Up to 3 sequential QuickBooks balance-sheet pulls plus the rollback queries.
export const maxDuration = 120;

interface GenerateRequestBody {
  month: string;
  basis: CloseBasis;
}

/**
 * POST /api/inventory/monthly-close/generate { month, basis } — persist the
 * month's inventory-close JEs as drafts (kind 'inventory') so they get the same
 * Approve → Post workflow as every other journal entry. Regeneration is locked
 * once any draft for the month has posted, mirroring the EOM generate gate.
 */
export async function POST(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const body = (await request.json()) as GenerateRequestBody;
    const basis: CloseBasis = body.basis === 'full' ? 'full' : 'floor';
    const monthEnd = monthEndDate(body.month ?? '');
    if (!monthEnd) {
      return NextResponse.json({ error: 'month is required as YYYY-MM' }, { status: 400 });
    }

    const result = await generateInvCloseDrafts(body.month, basis, monthEnd);
    if ('locked' in result) {
      return NextResponse.json({ error: result.locked }, { status: 409 });
    }

    const stored = await loadStoredDrafts(monthEnd);
    return NextResponse.json({ ...stored, warnings: result.warnings });
  } catch (error) {
    console.error('[inventory/monthly-close/generate POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to generate inventory-close drafts';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
