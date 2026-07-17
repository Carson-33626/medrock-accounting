import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getAllocationRules, saveAllocationRuleSet, setAllocationRuleActive } from '@/lib/payroll/store';
import type { AllocationRule } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type PostBody =
  | { kind?: 'save'; costCenter: string; effectiveFrom: string; rules: AllocationRule[] }
  | { kind: 'setActive'; id: number; active: boolean };

/** GET /api/payroll/allocation-rules?costCenter= — list allocation rules (optionally scoped to one cost center). */
export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const costCenter = request.nextUrl.searchParams.get('costCenter') ?? undefined;
    const rules = await getAllocationRules(costCenter);
    return NextResponse.json({ rules });
  } catch (error) {
    console.error('[payroll/allocation-rules GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load allocation rules';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/payroll/allocation-rules — either saves a new allocation rule set for a cost
 * center (kind omitted or 'save') or toggles a single rule's active flag (kind: 'setActive').
 * A sum-to-100 validation failure from saveAllocationRuleSet is a client error (400), not a
 * server error (500).
 */
export async function POST(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const body = (await request.json()) as PostBody;

    if ('kind' in body && body.kind === 'setActive') {
      if (typeof body.id !== 'number' || typeof body.active !== 'boolean') {
        return NextResponse.json({ error: 'id (number) and active (boolean) are required' }, { status: 400 });
      }
      await setAllocationRuleActive(body.id, body.active);
      return NextResponse.json({ ok: true });
    }

    const { costCenter, effectiveFrom, rules } = body;
    if (!costCenter || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom ?? '') || !Array.isArray(rules)) {
      return NextResponse.json({ error: 'costCenter, effectiveFrom (YYYY-MM-DD) and rules[] are required' }, { status: 400 });
    }

    try {
      await saveAllocationRuleSet(costCenter, effectiveFrom, rules);
    } catch (e) {
      // sum-to-100 (and other validation) rejections are client errors, not 500s.
      const msg = e instanceof Error ? e.message : 'invalid rule set';
      if (/sum to 100/.test(msg)) return NextResponse.json({ error: msg }, { status: 400 });
      throw e;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[payroll/allocation-rules POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to save allocation rules';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
