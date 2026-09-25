import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { generateEomCorrection } from '@/lib/payroll/eom-correction-server';
import { EOM_ENTITIES, type EomEntity } from '@/lib/payroll/revenue-rule';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

interface CorrectionBody {
  month?: string;
  entity?: string;
}

function isEomEntity(v: string | undefined): v is EomEntity {
  return EOM_ENTITIES.some((e) => e === v);
}

/**
 * POST /api/payroll/eom/correction { month, entity } — generate (or regenerate) the
 * correction draft for a posted month-end: the allocation as computed now minus everything
 * already posted. Draft only — posting goes through /api/payroll/eom/post. DS 2026-09-25 §4.2.
 */
export async function POST(request: NextRequest) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();
  try {
    const body = (await request.json()) as CorrectionBody;
    const month = body.month;
    if (typeof month !== 'string' || !MONTH_RE.test(month)) {
      return NextResponse.json({ error: 'month is required as YYYY-MM' }, { status: 400 });
    }
    const entity = body.entity;
    if (!isEomEntity(entity)) {
      return NextResponse.json({ error: `entity must be one of ${EOM_ENTITIES.join(', ')}` }, { status: 400 });
    }

    const result = await generateEomCorrection(month, entity, new Date().toISOString().slice(0, 10));
    if ('locked' in result) {
      return NextResponse.json({ error: result.locked }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('[payroll/eom/correction POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to generate the correction';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
