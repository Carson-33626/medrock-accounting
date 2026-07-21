import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { selectSource } from '@/lib/payroll/source-select';
import { reconcile } from '@/lib/payroll/reconcile';
import { buildJournal, mergeRebuiltLines } from '@/lib/payroll/build-je';
import { loadDraft, saveDraft, getAccountMap, getEmployeeMap, sourceSnapshotHash } from '@/lib/payroll/store';
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
        const merged = mergeRebuiltLines(loaded.lines, built0.lines);
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
        await saveDraft(newDraft, currentHash);
        const updated = await loadDraft(headerId);
        if (updated) {
          lines = updated.lines;
          rebuiltDraft = updated;
          synced = true; // draft now built from current source → no drift
        }
      }
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

    const result = reconcile(draft, runRows, {
      unmappedColumns: built.unmappedColumns,
      unmappedPositions: built.unmappedPositions,
    });

    // I3: surface source drift so the UI can warn that the draft is stale before approval/post.
    // A rebuild just resynced the draft to current source, so drift is definitionally cleared.
    const hasDrift = synced ? false : !!header.source_snapshot_hash && currentHash !== header.source_snapshot_hash;

    // `unmappedColumnDetails` (amount + contributing people per unmapped column) rides alongside
    // the bare `result.unmappedColumns` string[] that drives postability — the Review tab's
    // "new columns detected" panel uses the details to show dollars + jump-to-source.
    // `rebuiltDraft` (present only when a rebuild ran) lets the client refresh its on-screen lines.
    return NextResponse.json({
      ...result,
      sourceDrift: hasDrift,
      unmappedColumnDetails: built.unmappedColumnDetails,
      ...(rebuiltDraft ? { rebuiltDraft } : {}),
    });
  } catch (error) {
    console.error('[payroll/reconcile POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to reconcile payroll draft';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
