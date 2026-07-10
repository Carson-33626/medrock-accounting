import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { loadDraft, saveDraft } from '@/lib/payroll/store';
import type { JournalDraft, JournalLine } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PatchRequestBody {
  lines: JournalLine[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** GET /api/payroll/run/[id] — load one persisted draft (header + lines). */
export async function GET(_request: NextRequest, context: RouteContext) {
  // requireAuth redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAuth();

  try {
    const { id } = await context.params;
    const headerId = Number(id);
    if (!Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }

    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }

    return NextResponse.json(loaded);
  } catch (error) {
    console.error('[payroll/run/[id] GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load payroll draft';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** PATCH /api/payroll/run/[id] { lines } — edit a draft's lines, recompute totals, persist. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  // requireAuth redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAuth();

  try {
    const { id } = await context.params;
    const headerId = Number(id);
    if (!Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }

    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }
    const { header } = loaded;

    const body = (await request.json()) as PatchRequestBody;
    if (!Array.isArray(body.lines)) {
      return NextResponse.json({ error: 'lines array is required' }, { status: 400 });
    }
    const lines = body.lines;

    const totalDebits = round2(
      lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0),
    );
    const totalCredits = round2(
      lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0),
    );
    const variance = round2(totalDebits - totalCredits);

    const draft: JournalDraft = {
      entity: header.entity,
      payDate: header.pay_date,
      payGroup: header.pay_group,
      periodStart: header.period_start ?? '',
      periodEnd: header.period_end ?? '',
      lines,
      totalDebits,
      totalCredits,
      variance,
      rowKeys: [...new Set(lines.flatMap((l) => l.sourceRowKeys))],
    };

    const savedId = await saveDraft(draft, header.source_snapshot_hash ?? '');
    const updated = await loadDraft(savedId);
    if (!updated) {
      return NextResponse.json({ error: 'failed to reload draft after save' }, { status: 500 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('[payroll/run/[id] PATCH]', error);
    const message = error instanceof Error ? error.message : 'Failed to update payroll draft';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
