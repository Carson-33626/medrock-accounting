import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { loadDraft, insertAudit, setHeaderStatus } from '@/lib/payroll/store';
import { getEomRun } from '@/lib/payroll/eom-store';
import { postJournalEntry } from '@/lib/payroll/qb-journal';
import { eomDocNumber, eomPrivateNote } from '@/lib/payroll/month-end';
import { EOM_ENTITIES } from '@/lib/payroll/revenue-rule';
import type { Entity, JournalDraft } from '@/lib/payroll/types';
import type { AuditEntry, JsonValue } from '@/lib/payroll/store';
import type { Month } from '@/lib/payroll/month';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const pad2 = (n: number): string => String(n).padStart(2, '0');

interface PostRequestBody {
  headerId: number;
  mode: 'dry_run' | 'live';
}

/** `header.pay_date` is 'MM/DD/YYYY' for allocation headers too (month-end date). */
function monthFromPayDate(payDate: string): Month {
  const [mo, , y] = payDate.split('/');
  return { year: Number(y), month: Number(mo) };
}

/**
 * Pull `revenue.shares` back out of the stored `getEomRun(month).revenue` JsonValue
 * without any/unknown — narrows the union by hand and bails to null on any shape
 * mismatch (missing run row, missing shares, corrupt JSON) rather than throwing.
 */
function readShares(revenue: JsonValue): Record<Entity, number> | null {
  if (typeof revenue !== 'object' || revenue === null || Array.isArray(revenue)) return null;
  const shares = revenue.shares;
  if (typeof shares !== 'object' || shares === null || Array.isArray(shares)) return null;
  const out = {} as Record<Entity, number>;
  for (const e of EOM_ENTITIES) {
    const v = shares[e];
    if (typeof v !== 'number') return null;
    out[e] = v;
  }
  return out;
}

/**
 * POST /api/payroll/eom/post { headerId, mode } — two-step QuickBooks posting for
 * month-end allocation JEs, mirroring /api/payroll/post's gate/audit discipline
 * (belt-and-suspenders qb_entry_id check, insertAudit on every outcome, error-path
 * audit in catch) minus the ADP-specific source refetch/reconcile/drift/split-sibling
 * machinery — an allocation draft has no source rows to drift against.
 *
 * SAFETY GATE order for mode === 'live' (dry_run always builds + returns a preview,
 * never writes, but still requires the header to exist and be kind 'allocation'):
 *   1. header not found -> 404; kind !== 'allocation' -> 400 (wrong route for payroll drafts).
 *   2. qb_entry_id already recorded OR status === 'posted' -> 409 'already posted'
 *      (belt-and-suspenders double-post guard, even if the two ever disagree).
 *   3. status !== 'approved' -> 409 'must be approved before posting'.
 *   4. variance !== 0 -> 409 'draft unbalanced' (belt-and-suspenders; the builder
 *      already guarantees a balanced draft — see month-end.buildMonthEndAllocation).
 * Every attempt (dry_run and live; blocked, preview, posted, error) is audited.
 */
export async function POST(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

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

    // GATE 1 (both modes): this route only ever posts month-end allocation JEs —
    // a payroll draft routed here would post with the wrong doc-number/note scheme.
    if (header.kind !== 'allocation') {
      return NextResponse.json({ error: 'header is not a month-end allocation draft' }, { status: 400 });
    }

    if (mode === 'live') {
      // GATE 2 (belt-and-suspenders): never re-post an already-posted header, even if
      // qb_entry_id and status somehow disagree.
      if (header.qb_entry_id || header.status === 'posted') {
        await insertAudit({ headerId, mode, entity, outcome: 'blocked', reason: 'already posted' });
        return NextResponse.json({ error: 'already posted', qbEntryId: header.qb_entry_id }, { status: 409 });
      }

      // GATE 3: an accountant must approve before this ever reaches QuickBooks.
      if (header.status !== 'approved') {
        await insertAudit({ headerId, mode, entity, outcome: 'blocked', reason: 'must be approved before posting' });
        return NextResponse.json({ error: 'must be approved before posting' }, { status: 409 });
      }

      // GATE 4 (belt-and-suspenders): buildMonthEndAllocation already throws on an
      // unbalanced draft before it's ever saved, but never trust a stale/edited row.
      if (header.variance !== 0) {
        await insertAudit({ headerId, mode, entity, outcome: 'blocked', reason: 'draft unbalanced' });
        return NextResponse.json({ error: 'draft unbalanced', variance: header.variance }, { status: 409 });
      }
    }

    const m = monthFromPayDate(header.pay_date);
    const month = `${m.year}-${pad2(m.month)}`;

    let privateNote = `Month-end allocation — ${month}`;
    const run = await getEomRun(month);
    if (run) {
      const shares = readShares(run.revenue);
      if (shares) privateNote = eomPrivateNote(shares, m);
    }

    const draft: JournalDraft = {
      entity: header.entity,
      kind: 'allocation',
      payDate: header.pay_date,
      payGroup: header.pay_group,
      periodStart: header.period_start ?? '',
      periodEnd: header.period_end ?? '',
      periodSegment: header.period_segment,
      docNumber: eomDocNumber(header.entity, m),
      txnDate: header.txn_date ?? undefined,
      privateNote,
      lines,
      totalDebits: header.total_debits,
      totalCredits: header.total_credits,
      variance: header.variance,
      rowKeys: [...new Set(lines.flatMap((l) => l.sourceRowKeys))],
    };

    const result = await postJournalEntry(header.entity, draft, { mode });

    // I2: on live success, flip the header's status/qb_entry_id BEFORE writing the audit
    // row — that status flip (not the audit) is what blocks a retry from double-posting.
    // If postJournalEntry succeeded but the audit write below then threw, a header still
    // stuck on 'approved' with no qb_entry_id would sail through every gate again.
    if (mode === 'live') {
      await setHeaderStatus(headerId, 'posted', { entryId: result.qbEntryId, docNumber: result.qbDocNumber });
    }

    await insertAudit({
      headerId,
      mode,
      entity: header.entity,
      qbDocNumber: result.qbDocNumber,
      qbEntryId: result.qbEntryId,
      outcome: mode === 'dry_run' ? 'preview' : 'posted',
      requestPayload: JSON.parse(JSON.stringify(result.payload)) as JsonValue,
      responseBody: result.response ?? null,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[payroll/eom/post POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to post month-end allocation journal entry';

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
        console.error('[payroll/eom/post POST] failed to write error audit entry', auditError);
      }
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
