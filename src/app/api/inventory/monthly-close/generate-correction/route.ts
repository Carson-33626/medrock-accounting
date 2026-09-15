import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { generateInvCloseCorrection, loadStoredDrafts, monthEndDate } from '@/lib/inventory/close-server';
import { QB_LOCATIONS } from '@/lib/qb-links';
import type { CloseBasis } from '@/types/inventory';
import type { Entity } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

interface Body {
  month: string;
  basis?: CloseBasis;
  entity: string;
}

/**
 * POST /api/inventory/monthly-close/generate-correction { month, basis, entity } —
 * draft a CORRECTION to an already-posted month for one company: the month recomputed
 * against a book that now contains the posted entry, saved as `<parent>-2` (then -3, …).
 * See docs/fifo-monthly-close/ds-correction-entry-2026-09-15.md.
 *
 * 409 with the reason when there is no posted parent, the month is cutover-locked, or
 * the figures could not be read; 200 with `nothingToCorrect` when the recompute is $0.
 */
export async function POST(request: NextRequest) {
  await requireManager();
  try {
    const body = (await request.json()) as Body;
    const monthEnd = monthEndDate(body.month ?? '');
    if (!monthEnd) return NextResponse.json({ error: 'month is required as YYYY-MM' }, { status: 400 });
    const entity = QB_LOCATIONS.find((e) => e === body.entity);
    if (!entity) return NextResponse.json({ error: 'entity must be one of MedRock FL / TN / TX' }, { status: 400 });
    const basis: CloseBasis = body.basis === 'full' ? 'full' : 'floor';

    const result = await generateInvCloseCorrection(body.month, basis, monthEnd, entity as Entity);
    if ('locked' in result) return NextResponse.json({ error: result.locked }, { status: 409 });
    const stored = await loadStoredDrafts(monthEnd);
    if ('nothingToCorrect' in result) {
      return NextResponse.json({ nothingToCorrect: true, warnings: result.warnings, ...stored });
    }
    return NextResponse.json({ headerId: result.headerId, docNumber: result.docNumber, warnings: result.warnings, ...stored });
  } catch (error) {
    console.error('[inventory/monthly-close/generate-correction POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to generate the correction';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
