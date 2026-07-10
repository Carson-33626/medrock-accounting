import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { selectSource } from '@/lib/payroll/source-select';
import { reconcile } from '@/lib/payroll/reconcile';
import { postJournalEntry } from '@/lib/payroll/qb-journal';
import { loadDraft, insertAudit, setHeaderStatus } from '@/lib/payroll/store';
import { decidePostable } from '@/lib/payroll/post-guard';
import type { Entity, JournalDraft } from '@/lib/payroll/types';
import type { AuditEntry, JsonValue } from '@/lib/payroll/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PostRequestBody {
  headerId: number;
  mode: 'dry_run' | 'live';
}

/** Converts an ADP-style MM/DD/YYYY date string to an ISO YYYY-MM-DD date string. */
function mmddyyyyToIso(mmddyyyy: string): string {
  const [month, day, year] = mmddyyyy.split('/');
  return `${year}-${month}-${day}`;
}

/**
 * POST /api/payroll/post { headerId, mode } — two-step QuickBooks posting.
 *
 * SAFETY GATE: when mode === 'live', the draft must reconcile to `postable: true`
 * before QuickBooks is ever contacted (see `decidePostable`). A non-postable
 * live request short-circuits with 409 and `postJournalEntry` is never called.
 * `dry_run` always builds + returns the payload for preview without posting.
 * Every attempt (dry_run and live, success and failure) is audited.
 */
export async function POST(request: NextRequest) {
  // requireAuth redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAuth();

  let headerId: number | null = null;
  let mode: 'dry_run' | 'live' = 'dry_run';
  let entity: Entity | null = null;

  try {
    const body = (await request.json()) as PostRequestBody;
    headerId = body.headerId;
    mode = body.mode;

    if (typeof headerId !== 'number' || !Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'headerId is required' }, { status: 400 });
    }
    if (mode !== 'dry_run' && mode !== 'live') {
      return NextResponse.json({ error: "mode must be 'dry_run' or 'live'" }, { status: 400 });
    }

    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }
    const { header, lines } = loaded;
    entity = header.entity;

    const draft: JournalDraft = {
      entity: header.entity,
      payDate: header.pay_date,
      payGroup: header.pay_group,
      periodStart: header.period_start ?? '',
      periodEnd: header.period_end ?? '',
      lines,
      totalDebits: header.total_debits,
      totalCredits: header.total_credits,
      variance: header.variance,
      rowKeys: [...new Set(lines.flatMap((l) => l.sourceRowKeys))],
    };

    const dayIso = mmddyyyyToIso(header.pay_date);
    const dayRows = await selectSource().fetchRange(dayIso, dayIso);
    const rows = dayRows.filter((r) => r.pay_group === header.pay_group);

    const reconcileResult = reconcile(draft, rows, { unmappedColumns: [], unmappedPositions: [] });

    // SAFETY GATE: never call QuickBooks for a non-postable live post.
    const decision = decidePostable(reconcileResult, mode);
    if (!decision.allowed) {
      return NextResponse.json({ error: 'not postable', reconcile: reconcileResult }, { status: decision.status });
    }

    const result = await postJournalEntry(header.entity, draft, { mode });

    await insertAudit({
      headerId,
      mode,
      entity: header.entity,
      qbDocNumber: result.qbDocNumber,
      qbEntryId: result.qbEntryId,
      outcome: mode === 'dry_run' ? 'preview' : 'posted',
      requestPayload: result.payload as unknown as JsonValue,
      responseBody: result.response ?? null,
    });

    if (mode === 'live') {
      await setHeaderStatus(headerId, 'posted', { entryId: result.qbEntryId, docNumber: result.qbDocNumber });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[payroll/post POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to post payroll journal entry';

    // Only audit if we know which entity this was for (i.e. loadDraft succeeded before the failure).
    if (headerId !== null && entity !== null) {
      const auditEntry: AuditEntry = {
        headerId,
        mode,
        entity,
        outcome: 'error',
        reason: message,
      };
      try {
        await insertAudit(auditEntry);
      } catch (auditError) {
        console.error('[payroll/post POST] failed to write error audit entry', auditError);
      }
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
