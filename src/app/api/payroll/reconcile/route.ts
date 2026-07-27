import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { selectSource } from '@/lib/payroll/source-select';
import { reconcile } from '@/lib/payroll/reconcile';
import { buildJournal, mergeRebuiltLines } from '@/lib/payroll/build-je';
import {
  loadDraft,
  saveDraft,
  getAccountMap,
  getEmployeeMap,
  sourceSnapshotHash,
  listSiblings,
  deleteStaleSiblings,
} from '@/lib/payroll/store';
import { splitStraddle } from '@/lib/payroll/split';
import { adpDateToIso } from '@/lib/payroll/dates';
import type { JournalDraft, JournalLine } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ReconcileRequestBody {
  headerId: number;
  /**
   * When true (fired by a mapping/region change, not a passive reconcile), regenerate this
   * draft's `generated` lines from the current account/employee map so a column that was just
   * mapped actually flows its dollars into the JE. Manual/inter-entity lines are preserved.
   * Without this, mapping a column clears the "unmapped" flag but leaves the draft out of
   * balance with nothing left to act on — the reconcile dead-end Barbara hit.
   */
  rebuild?: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * POST /api/payroll/reconcile { headerId, rebuild? } — recompute + validate one persisted draft.
 *
 * Unmapped columns/positions are recomputed for real via `buildJournal` over this run's
 * rows (not hardcoded empty) so `reconcile.postable` reflects the actual mapping state.
 * The response also includes `sourceDrift` (I3): whether the source rows have changed
 * since this draft's source_snapshot_hash was captured.
 *
 * With `rebuild: true`, the freshly-built generated lines are merged into the draft (keeping
 * hand-authored manual/inter-entity lines) and persisted, so a newly-mapped column's money is
 * reflected in the balance. The updated draft (header + lines) rides back in `rebuiltDraft`.
 */
export async function POST(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const body = (await request.json()) as ReconcileRequestBody;
    const { headerId, rebuild } = body;
    if (typeof headerId !== 'number' || !Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'headerId is required' }, { status: 400 });
    }

    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }
    const { header } = loaded;

    const siblings = await listSiblings(header.entity, header.pay_date, header.pay_group);
    const isSplit = siblings.length > 1;

    const dayIso = adpDateToIso(header.pay_date);
    const dayRows = await selectSource().fetchRange(dayIso, dayIso);
    const runRows = dayRows.filter((r) => r.pay_group === header.pay_group);

    const [accountMap, employeeMap] = await Promise.all([
      getAccountMap(header.entity),
      getEmployeeMap(header.entity),
    ]);
    const built = buildJournal(runRows, accountMap, employeeMap);
    const currentHash = sourceSnapshotHash(runRows);

    // Rebuild-on-map: regenerate this draft's generated lines from the current mappings so a
    // just-mapped column flows into the JE. Never touch a posted draft; only rebuild when the
    // builder actually produced a matching draft for this (entity, pay_date, pay_group).
    let lines: JournalLine[] = loaded.lines;
    let rebuiltDraft: { header: typeof header; lines: JournalLine[] } | null = null;
    let synced = false;
    if (rebuild && header.status !== 'posted') {
      const built0 = built.drafts.find(
        (d) => d.entity === header.entity && d.payDate === header.pay_date && d.payGroup === header.pay_group,
      );
      if (built0) {
        // Combined existing lines across ALL sibling pieces — manual/inter-entity lines
        // anywhere in the pair are preserved by the merge, then re-prorated by the split.
        const siblingLoads = await Promise.all(siblings.map((s) => loadDraft(s.id)));
        const combinedExisting = siblingLoads.flatMap((l) => l?.lines ?? []);
        const merged = mergeRebuiltLines(combinedExisting, built0.lines);
        const totalDebits = round2(merged.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
        const totalCredits = round2(merged.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
        const newDraft: JournalDraft = {
          entity: header.entity,
          payDate: header.pay_date,
          payGroup: header.pay_group,
          periodStart: built0.periodStart,
          periodEnd: built0.periodEnd,
          lines: merged,
          totalDebits,
          totalCredits,
          variance: round2(totalDebits - totalCredits),
          rowKeys: [...new Set(merged.flatMap((l) => l.sourceRowKeys))],
        };
        const pieces = splitStraddle(newDraft);
        for (const piece of pieces) {
          await saveDraft(piece, currentHash);
        }
        await deleteStaleSiblings(
          header.entity, header.pay_date, header.pay_group,
          pieces.map((p) => p.periodSegment ?? ''),
        );
        const updated = await loadDraft(headerId);
        if (updated) {
          lines = updated.lines;
          rebuiltDraft = updated;
          synced = true; // draft now built from current source → no drift
        }
      }
    }

    // Re-list siblings AFTER a possible rebuild so the combined set reflects what was just saved.
    let reconcileLines: JournalLine[] = lines;
    let reconcileTotals = { totalDebits: header.total_debits, totalCredits: header.total_credits, variance: header.variance };
    if (isSplit) {
      const freshSiblings = await listSiblings(header.entity, header.pay_date, header.pay_group);
      const loads = await Promise.all(freshSiblings.map((s) => (s.id === headerId ? Promise.resolve({ header, lines }) : loadDraft(s.id))));
      reconcileLines = loads.flatMap((l) => l?.lines ?? []);
      const d = round2(reconcileLines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
      const c = round2(reconcileLines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
      reconcileTotals = { totalDebits: d, totalCredits: c, variance: round2(d - c) };
    }

    const draft: JournalDraft = {
      entity: header.entity,
      payDate: header.pay_date,
      payGroup: header.pay_group,
      periodStart: header.period_start ?? '',
      periodEnd: header.period_end ?? '',
      lines: reconcileLines,
      ...reconcileTotals,
      rowKeys: [...new Set(reconcileLines.flatMap((l) => l.sourceRowKeys))],
    };

    const result = reconcile(draft, runRows, {
      unmappedColumns: built.unmappedColumns,
      unmappedPositions: built.unmappedPositions,
    });

    // I3: surface source drift so the UI can warn that the draft is stale before approval/post.
    // A rebuild just resynced the draft to current source, so drift is definitionally cleared.
    const hasDrift = synced ? false : !!header.source_snapshot_hash && currentHash !== header.source_snapshot_hash;

    // The original run's totals come from the freshly built (unsplit) draft — recomputed from
    // source, so manual-edit drift shows up as variance, which is exactly what the grand
    // summary wants.
    const built0ForOriginal = built.drafts.find(
      (d) => d.entity === header.entity && d.payDate === header.pay_date && d.payGroup === header.pay_group,
    );
    const splitBlock = isSplit
      ? {
          siblings: await listSiblings(header.entity, header.pay_date, header.pay_group),
          original: built0ForOriginal
            ? { totalDebits: built0ForOriginal.totalDebits, totalCredits: built0ForOriginal.totalCredits }
            : { totalDebits: reconcileTotals.totalDebits, totalCredits: reconcileTotals.totalCredits },
        }
      : undefined;

    // `unmappedColumnDetails` (amount + contributing people per unmapped column) rides alongside
    // the bare `result.unmappedColumns` string[] that drives postability — the Review tab's
    // "new columns detected" panel uses the details to show dollars + jump-to-source.
    // `rebuiltDraft` (present only when a rebuild ran) lets the client refresh its on-screen lines.
    return NextResponse.json({
      ...result,
      sourceDrift: hasDrift,
      unmappedColumnDetails: built.unmappedColumnDetails,
      ...(rebuiltDraft ? { rebuiltDraft } : {}),
      ...(splitBlock ? { split: splitBlock } : {}),
    });
  } catch (error) {
    console.error('[payroll/reconcile POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to reconcile payroll draft';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
