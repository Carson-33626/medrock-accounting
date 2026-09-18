import { NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { fetchCloseDrift } from '@/lib/inventory/close-drift-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// One balance sheet per posted month per company plus a late-entry scan per company.
export const maxDuration = 300;

/**
 * GET /api/inventory/monthly-close/drift — for every posted monthly close, how far the books
 * have moved from FIFO since it posted, split into late QuickBooks entries and FIFO movement,
 * and which month to correct first. Read-only.
 * See docs/fifo-monthly-close/ds-close-drift-guard-2026-09-18.md.
 */
export async function GET() {
  await requireManager();
  try {
    return NextResponse.json(await fetchCloseDrift());
  } catch (error) {
    console.error('[inventory/monthly-close/drift GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to compute close drift';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
