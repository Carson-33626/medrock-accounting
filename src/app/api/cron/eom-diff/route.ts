import { NextRequest, NextResponse } from 'next/server';
import { runEomDiff } from '@/lib/payroll/eom-diff-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/** GET /api/cron/eom-diff — Vercel cron (vercel.json), daily. Vercel sends
 *  `Authorization: Bearer $CRON_SECRET`; anything else is refused. Middleware lists this
 *  path under SELF_AUTH_ROUTES. DS 2026-09-25 §4.1. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json(await runEomDiff('cron'));
  } catch (error) {
    console.error('[cron/eom-diff]', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'difference check failed' }, { status: 500 });
  }
}
