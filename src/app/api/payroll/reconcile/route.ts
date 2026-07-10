import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { selectSource } from '@/lib/payroll/source-select';
import { reconcile } from '@/lib/payroll/reconcile';
import { buildJournal } from '@/lib/payroll/build-je';
import { loadDraft, getAccountMap, getEmployeeMap, sourceSnapshotHash } from '@/lib/payroll/store';
import { adpDateToIso } from '@/lib/payroll/dates';
import type { JournalDraft } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ReconcileRequestBody {
  headerId: number;
}

/**
 * POST /api/payroll/reconcile { headerId } — recompute + validate one persisted draft.
 *
 * Unmapped columns/positions are recomputed for real via `buildJournal` over this run's
 * rows (not hardcoded empty) so `reconcile.postable` reflects the actual mapping state.
 * The response also includes `sourceDrift` (I3): whether the source rows have changed
 * since this draft's source_snapshot_hash was captured.
 */
export async function POST(request: NextRequest) {
  // requireAuth redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAuth();

  try {
    const body = (await request.json()) as ReconcileRequestBody;
    const { headerId } = body;
    if (typeof headerId !== 'number' || !Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'headerId is required' }, { status: 400 });
    }

    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }
    const { header, lines } = loaded;

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

    const result = reconcile(draft, runRows, {
      unmappedColumns: built.unmappedColumns,
      unmappedPositions: built.unmappedPositions,
    });

    // I3: surface source drift so the UI can warn that the draft is stale before approval/post.
    const currentHash = sourceSnapshotHash(runRows);
    const hasDrift = !!header.source_snapshot_hash && currentHash !== header.source_snapshot_hash;

    return NextResponse.json({ ...result, sourceDrift: hasDrift });
  } catch (error) {
    console.error('[payroll/reconcile POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to reconcile payroll draft';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
