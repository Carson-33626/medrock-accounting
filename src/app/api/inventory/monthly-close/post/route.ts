import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { loadDraft, insertAudit, setHeaderStatus } from '@/lib/payroll/store';
import { postJournalEntry } from '@/lib/payroll/qb-journal';
import { attachJeWorkbook } from '@/lib/payroll/je-attach';
import {
  invCloseDocNumber,
  openingCorrectionDocNumber,
  INV_OPEN_PAY_GROUP,
  OPENING_CORRECTION_NOTE,
} from '@/lib/inventory/monthly-close';
import { LAB_ACCRUAL_PAY_GROUP, labAccrualIdentity } from '@/lib/inventory/lab-supplies-je';
import type { Entity, JournalDraft } from '@/lib/payroll/types';
import type { AuditEntry, JsonValue } from '@/lib/payroll/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PostRequestBody {
  headerId: number;
  mode: 'dry_run' | 'live';
}

/** `header.pay_date` is 'MM/DD/YYYY' (the month-end date) → 'YYYY-MM'. */
function monthFromPayDate(payDate: string): string {
  const [mo, , y] = payDate.split('/');
  return `${y}-${mo}`;
}

/**
 * POST /api/inventory/monthly-close/post { headerId, mode } — two-step QuickBooks
 * posting for inventory-close JEs, mirroring /api/payroll/eom/post's gate/audit
 * discipline exactly:
 *   1. header not found -> 404; kind !== 'inventory' -> 400 (wrong route).
 *   2. qb_entry_id already recorded OR status === 'posted' -> 409 'already posted'.
 *   3. status !== 'approved' -> 409 'must be approved before posting'.
 *   4. variance !== 0 -> 409 'draft unbalanced'.
 * Every attempt (dry_run and live; blocked, preview, posted, error) is audited.
 */
export async function POST(request: NextRequest) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();

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

    // The lab-supplies accrual pair rides this route too (Carson, 2026-09-03: "add this
    // on the COGS/Inventory journal entries so that this piece becomes visible and they
    // can use the inventory JE to post this"). It is inventory cost by nature and the
    // accountants work the close from one screen, so it gets the same gates, the same
    // audit and the same Approve -> Dry run -> Post workflow. It keeps kind 'accrual' /
    // 'reversal' because that IS what it is — the kind drives the reversal semantics.
    const isLabAccrual = header.pay_group === LAB_ACCRUAL_PAY_GROUP;

    // GATE 1 (both modes): this route only ever posts inventory-close JEs and the lab
    // accrual — any other draft routed here would post with the wrong doc-number/note
    // scheme.
    if (isLabAccrual) {
      if (header.kind !== 'accrual' && header.kind !== 'reversal') {
        return NextResponse.json(
          { error: 'lab-accrual header must be kind accrual or reversal' },
          { status: 400 },
        );
      }
    } else if (header.kind !== 'inventory') {
      return NextResponse.json({ error: 'header is not an inventory-close draft' }, { status: 400 });
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

      // GATE 4 (belt-and-suspenders): the generate step only saves balanced two-line
      // drafts, but never trust a stale/edited row.
      if (header.variance !== 0) {
        await insertAudit({ headerId, mode, entity, outcome: 'blocked', reason: 'draft unbalanced' });
        return NextResponse.json({ error: 'draft unbalanced', variance: header.variance }, { status: 409 });
      }
    }

    const month = monthFromPayDate(header.pay_date);

    // The opening correction (pay_group 'INV OPEN') shares this route's gates
    // and audit but carries its own doc-number/note scheme — 'FL Inv Open
    // 2026.03', never the monthly 'Inv Adj', so the two are distinct in QB.
    const isOpeningCorrection = header.pay_group === INV_OPEN_PAY_GROUP;

    // The accrual month is the PERIOD, not the pay date — the reversal's pay date is
    // the first of the following month and would derive the wrong tag.
    const labId = isLabAccrual
      ? labAccrualIdentity(
          (header.period_end ?? '').slice(0, 7),
          header.kind === 'reversal' ? 'reversal' : 'accrual',
        )
      : null;

    const draft: JournalDraft = {
      entity: header.entity,
      kind: isLabAccrual ? (header.kind === 'reversal' ? 'reversal' : 'accrual') : 'inventory',
      payDate: header.pay_date,
      payGroup: header.pay_group,
      periodStart: header.period_start ?? '',
      periodEnd: header.period_end ?? '',
      periodSegment: header.period_segment,
      docNumber: labId
        ? labId.docNumber
        : isOpeningCorrection
          ? openingCorrectionDocNumber(header.entity, month)
          : invCloseDocNumber(header.entity, month),
      txnDate: labId ? labId.txnDateIso : (header.txn_date ?? undefined),
      // The stored line memos carry the basis + as-of date; the note stays stable.
      privateNote: labId
        ? labId.privateNote
        : isOpeningCorrection
          ? OPENING_CORRECTION_NOTE
          : `Inventory FIFO close adjustment — ${month}`,
      lines,
      totalDebits: header.total_debits,
      totalCredits: header.total_credits,
      variance: header.variance,
      rowKeys: [...new Set(lines.flatMap((l) => l.sourceRowKeys))],
    };

    const result = await postJournalEntry(header.entity, draft, { mode });

    // On live success, flip the header's status/qb_entry_id BEFORE writing the audit
    // row — that status flip (not the audit) is what blocks a retry from double-posting.
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

    // Attach the entry's own workbook — the posted lines plus the category bridge and lot
    // detail behind them. A FOLLOW-ON STEP, NEVER A GATE (DS §3.3): the JE is already live in
    // QuickBooks, so `attachJeWorkbook` records its own outcome and never throws.
    const attachment = mode === 'live' && result.qbEntryId
      ? await attachJeWorkbook({ ...header, status: 'posted' }, lines, { entryId: result.qbEntryId, docNumber: result.qbDocNumber })
      : undefined;

    return NextResponse.json({ ...result, attachment });
  } catch (error) {
    console.error('[inventory/monthly-close/post POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to post inventory-close journal entry';

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
        console.error('[inventory/monthly-close/post POST] failed to write error audit entry', auditError);
      }
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
