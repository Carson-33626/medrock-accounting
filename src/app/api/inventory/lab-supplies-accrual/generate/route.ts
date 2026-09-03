import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { generateLabAccrualDrafts } from '@/lib/inventory/lab-supplies-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Three QuickBooks realms, each an Account list plus a Bill and Purchase pull.
export const maxDuration = 120;

interface GenerateRequestBody {
  month?: string;
}

/**
 * POST /api/inventory/lab-supplies-accrual/generate { month } — persist the
 * month's lab-supplies accrual as drafts, so it gets the same Approve → Post
 * workflow as every other journal entry.
 *
 * Each location that has something to accrue produces a PAIR — the accrual dated
 * month-end and its reversal dated the first of the next month. The reversal
 * matters: once the real bills are keyed they are coded to 1220.20 and the FIFO
 * close expenses them, so an accrual left standing would double-count exactly the
 * spend it was covering.
 *
 * Writes to OUR draft table only. Nothing reaches QuickBooks here.
 */
export async function POST(request: NextRequest) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();

  try {
    const body = (await request.json().catch(() => ({}))) as GenerateRequestBody;
    const month = body.month ?? '';
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: 'month is required as YYYY-MM' }, { status: 400 });
    }

    const result = await generateLabAccrualDrafts(month);
    return NextResponse.json({ month, ...result });
  } catch (error) {
    console.error('[inventory/lab-supplies-accrual/generate POST]', error);
    const message =
      error instanceof Error ? error.message : 'Failed to generate lab-supplies accrual drafts';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
