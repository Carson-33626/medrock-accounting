import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { selectSource } from '@/lib/payroll/source-select';
import { buildJournal } from '@/lib/payroll/build-je';
import { splitStraddle } from '@/lib/payroll/split';
import { adpDateToIso } from '@/lib/payroll/dates';
import { isPayrollPeriodComplete, PERIOD_COMPLETE_MESSAGE } from '@/lib/payroll/period-locks';
import {
  loadDraft, listSiblings, getAccountMap, getEmployeeMap, saveDraft, deleteStaleSiblings, runSnapshotHash,
} from '@/lib/payroll/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/payroll/run/[id]/rebuild — rebuild ONE run from the current source rows.
 *
 * The fix for the drift gate: when the ADP rows behind a run change after its draft was built,
 * the post is blocked ("source changed since draft was built") and the only correct move is to
 * rebuild and re-review. That used to mean an engineer running regen-drafts.ts.
 *
 * Scoped deliberately to this run (entity + pay_date + pay_group). POST /api/payroll/runs
 * would also do the job, but it rebuilds every run in the date range it is given, so rebuilding
 * one TX run would silently reset FL's and TN's approvals for the same pay date.
 *
 * Rebuilding necessarily resets the run to needs_review — saveDraft forces that status — which
 * is the point: the reconcile and approval that were done against the old numbers must not
 * carry over. Split runs rebuild as a pair, since one piece's numbers cannot be trusted while
 * its sibling's are stale.
 *
 * Refuses a posted run (nothing may rewrite the lines behind a live QuickBooks entry; the
 * saveDraft C1 gate would skip it anyway) and a closed period.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

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

    if (isPayrollPeriodComplete(header.pay_date)) {
      return NextResponse.json({ error: PERIOD_COMPLETE_MESSAGE }, { status: 409 });
    }

    // A posted piece is immutable. For a split run this also means a pair that is half posted
    // cannot be rebuilt — rebuilding the unposted half against fresh source would leave the two
    // months built from different snapshots. That state needs a human decision, not a button.
    const siblingsBefore = await listSiblings(header.entity, header.pay_date, header.pay_group);
    const postedPiece = siblingsBefore.find((s) => s.status === 'posted');
    if (postedPiece) {
      return NextResponse.json(
        {
          error:
            siblingsBefore.length > 1
              ? 'Part of this split run is already posted in QuickBooks — it cannot be rebuilt. Post the remaining piece, or have the posted entry reversed first.'
              : 'This run is already posted in QuickBooks — it cannot be rebuilt.',
        },
        { status: 409 },
      );
    }

    const dayIso = adpDateToIso(header.pay_date);
    const rows = await selectSource().fetchRange(dayIso, dayIso);

    const [accountMap, employeeMap] = await Promise.all([
      getAccountMap(header.entity),
      getEmployeeMap(header.entity),
    ]);
    const { drafts } = buildJournal(rows, accountMap, employeeMap);

    const draft = drafts.find((d) => d.entity === header.entity && d.payDate === header.pay_date && d.payGroup === header.pay_group);
    if (!draft) {
      // The run no longer exists in the source at all (rows pulled/re-keyed). Rebuilding would
      // mean deleting the draft, which is not this endpoint's call to make.
      return NextResponse.json(
        { error: 'This run no longer appears in the payroll source for its pay date — nothing to rebuild. Send it to engineering.' },
        { status: 409 },
      );
    }

    // Per-run hash, matching the post route's drift recompute exactly. Getting this wrong is
    // what makes a draft unpostable in the first place — see store.ts runSnapshotHash.
    const snapshot = runSnapshotHash(rows, draft.payDate, draft.payGroup);
    const pieces = splitStraddle(draft);
    for (const piece of pieces) {
      await saveDraft(piece, snapshot);
    }
    await deleteStaleSiblings(
      draft.entity, draft.payDate, draft.payGroup,
      pieces.map((p) => p.periodSegment ?? ''),
    );

    // Return the caller's own header by identity (entity + pay_date + pay_group + segment), not
    // by id: deleteStaleSiblings can retire the row the panel was holding when the segment set
    // changes, and the panel needs whatever now represents this piece.
    const siblings = await listSiblings(header.entity, header.pay_date, header.pay_group);
    const same = siblings.find((s) => s.period_segment === header.period_segment) ?? siblings[0];
    if (!same) {
      return NextResponse.json({ error: 'rebuild saved no header for this run' }, { status: 500 });
    }
    const reloaded = await loadDraft(same.id);
    if (!reloaded) {
      return NextResponse.json({ error: 'failed to reload draft after rebuild' }, { status: 500 });
    }

    return NextResponse.json({ ...reloaded, siblings, pieceCount: pieces.length });
  } catch (error) {
    console.error('[payroll/run/[id]/rebuild POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to rebuild payroll run';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
