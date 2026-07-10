import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { selectSource } from '@/lib/payroll/source-select';
import { reconcile } from '@/lib/payroll/reconcile';
import { loadDraft } from '@/lib/payroll/store';
import type { JournalDraft } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ReconcileRequestBody {
  headerId: number;
}

/** Converts an ADP-style MM/DD/YYYY date string to an ISO YYYY-MM-DD date string. */
function mmddyyyyToIso(mmddyyyy: string): string {
  const [month, day, year] = mmddyyyy.split('/');
  return `${year}-${month}-${day}`;
}

/** POST /api/payroll/reconcile { headerId } — recompute + validate one persisted draft. */
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

    const dayIso = mmddyyyyToIso(header.pay_date);
    const dayRows = await selectSource().fetchRange(dayIso, dayIso);
    const rows = dayRows.filter((r) => r.pay_group === header.pay_group);

    const result = reconcile(draft, rows, { unmappedColumns: [], unmappedPositions: [] });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[payroll/reconcile POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to reconcile payroll draft';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
