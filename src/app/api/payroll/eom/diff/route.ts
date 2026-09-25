import { NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { runEomDiff, getEomDiffStatus } from '@/lib/payroll/eom-diff-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/** GET /api/payroll/eom/diff — the month-end difference check's settings, last run and
 *  per-month/entity checks (flagged ones grouped). DS 2026-09-25 §4.1. */
export async function GET() {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();
  try {
    return NextResponse.json(await getEomDiffStatus());
  } catch (error) {
    console.error('[payroll/eom/diff GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load the difference check';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST /api/payroll/eom/diff — "Check now": a manual run (ignores the enabled toggle),
 *  then the refreshed status. */
export async function POST() {
  await requireManager();
  try {
    const run = await runEomDiff('manual');
    return NextResponse.json({ run, status: await getEomDiffStatus() });
  } catch (error) {
    console.error('[payroll/eom/diff POST]', error);
    const message = error instanceof Error ? error.message : 'difference check failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
