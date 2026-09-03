import { NextResponse } from 'next/server';
import { fetchLabSuppliesAccrual } from '@/lib/inventory/lab-supplies-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The lab-supplies accrual, computed live against QuickBooks.
 *
 * Lab supplies were cleared out of FIFO entirely (Carson, 2026-09-03) because they
 * are bought ad hoc and never received into LifeFile — the ledger has no basis to
 * deplete. This replaces that missing depletion with a simulated monthly cost,
 * sized from what QuickBooks has actually recorded so far.
 *
 * The reading itself lives in `lib/inventory/lab-supplies-server` because the draft
 * generator needs the identical figure; two code paths to QuickBooks is how a
 * screen and the entry it describes drift apart.
 *
 * Read-only — nothing is written to QuickBooks.
 */
export type {
  LabSuppliesAccrualMonth,
  LabSuppliesAccrualResponse,
} from '@/lib/inventory/lab-supplies-server';

export async function GET() {
  const body = await fetchLabSuppliesAccrual();
  return NextResponse.json(body);
}
