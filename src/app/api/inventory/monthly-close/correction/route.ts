import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { computeOpeningCorrection, generateOpeningCorrectionDrafts } from '@/lib/inventory/close-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Three QuickBooks balance-sheet + dimension pulls, run twice (generate + reload).
export const maxDuration = 120;

/**
 * POST /api/inventory/monthly-close/correction — persist the one-time opening
 * correction (cutover to FIFO, 2026-03-01) as drafts, pay_group 'INV OPEN', so
 * it gets the same Approve → Post workflow as the monthly close. Regeneration
 * is locked once any correction has posted.
 */
export async function POST() {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const result = await generateOpeningCorrectionDrafts();
    if ('locked' in result) {
      return NextResponse.json({ error: result.locked }, { status: 409 });
    }
    const correction = await computeOpeningCorrection();
    return NextResponse.json({ ...correction, warnings: result.warnings });
  } catch (error) {
    console.error('[inventory/monthly-close/correction POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to generate the opening correction';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
