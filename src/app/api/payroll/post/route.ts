import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { selectSource } from '@/lib/payroll/source-select';
import { reconcile } from '@/lib/payroll/reconcile';
import { postJournalEntry } from '@/lib/payroll/qb-journal';
import { buildJournal } from '@/lib/payroll/build-je';
import { loadDraft, insertAudit, setHeaderStatus, getAccountMap, getEmployeeMap } from '@/lib/payroll/store';
import { decidePost } from '@/lib/payroll/post-guard';
import { adpDateToIso } from '@/lib/payroll/dates';
import type { Entity, JournalDraft } from '@/lib/payroll/types';
import type { AuditEntry, JsonValue } from '@/lib/payroll/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PostRequestBody {
  headerId: number;
  mode: 'dry_run' | 'live';
}

/**
 * POST /api/payroll/post { headerId, mode } — two-step QuickBooks posting.
 *
 * SAFETY GATE: when mode === 'live', ALL of the following must hold before QuickBooks
 * is ever contacted (see `decidePost`):
 *   - a decrypt key is configured (no silent fixture-source fallback for a live post);
 *   - the header is not already `posted` (no double-post on retry/resubmit);
 *   - the draft reconciles to `postable: true`, using REAL unmapped-columns/positions
 *     computed from `buildJournal` over this run's rows (not a hardcoded empty set).
 * A rejected live request short-circuits with the decision's status and `postJournalEntry`
 * is never called. `dry_run` always builds + returns the payload for preview without posting.
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

    const hasKey = !!process.env.PAYROLL_ENC_KEY;

    // SAFETY GATE: a live post must run against real RDS data — never the fixture fallback.
    if (mode === 'live' && !hasKey) {
      return NextResponse.json({ error: 'decrypt key not configured for live post' }, { status: 503 });
    }

    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }
    const { header, lines } = loaded;
    entity = header.entity;

    // SAFETY GATE: never re-post an already-posted header.
    if (mode === 'live' && header.status === 'posted') {
      return NextResponse.json({ error: 'already posted', qbEntryId: header.qb_entry_id }, { status: 409 });
    }

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

    const dayIso = adpDateToIso(header.pay_date);
    const dayRows = await selectSource().fetchRange(dayIso, dayIso);
    const runRows = dayRows.filter((r) => r.pay_group === header.pay_group);

    const [accountMap, employeeMap] = await Promise.all([
      getAccountMap(header.entity),
      getEmployeeMap(header.entity),
    ]);
    const built = buildJournal(runRows, accountMap, employeeMap);

    const reconcileResult = reconcile(draft, runRows, {
      unmappedColumns: built.unmappedColumns,
      unmappedPositions: built.unmappedPositions,
    });

    // SAFETY GATE: never call QuickBooks for a non-postable / already-posted / unkeyed live post.
    const decision = decidePost({ mode, reconcile: reconcileResult, headerStatus: header.status, hasKey });
    if (!decision.allowed) {
      return NextResponse.json(
        { error: decision.error ?? 'not postable', reconcile: reconcileResult },
        { status: decision.status },
      );
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
