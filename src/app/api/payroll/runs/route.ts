import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { selectSource } from '@/lib/payroll/source-select';
import { buildJournal } from '@/lib/payroll/build-je';
import { POSTABLE_ENTITIES } from '@/lib/payroll/entity';
import { getAccountMap, getEmployeeMap, saveDraft, sourceSnapshotHash, listHeaders } from '@/lib/payroll/store';
import type { AccountMapRule, EmployeeMapRule } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RunsRequestBody {
  start: string;
  end: string;
}

/** POST /api/payroll/runs { start, end } — build + persist draft JEs for the range. */
export async function POST(request: NextRequest) {
  // requireAuth redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAuth();

  try {
    const body = (await request.json()) as RunsRequestBody;
    const { start, end } = body;
    if (!start || !end || !ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
      return NextResponse.json({ error: 'start and end are required as YYYY-MM-DD' }, { status: 400 });
    }

    const rows = await selectSource().fetchRange(start, end);
    const snapshot = sourceSnapshotHash(rows);

    const accountMapLists: AccountMapRule[][] = await Promise.all(POSTABLE_ENTITIES.map(getAccountMap));
    const employeeMapLists: EmployeeMapRule[][] = await Promise.all(POSTABLE_ENTITIES.map(getEmployeeMap));
    const accountMap = accountMapLists.flat();
    const employeeMap = employeeMapLists.flat();

    const { drafts, unmappedColumns, unmappedPositions, excluded } = buildJournal(rows, accountMap, employeeMap);

    for (const draft of drafts) {
      await saveDraft(draft, snapshot);
    }

    const headers = await listHeaders(start, end);

    return NextResponse.json({ headers, unmappedColumns, unmappedPositions, excluded });
  } catch (error) {
    console.error('[payroll/runs POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to build payroll run';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** GET /api/payroll/runs?start=&end= — list persisted headers in the range. */
export async function GET(request: NextRequest) {
  await requireAuth();

  try {
    const sp = request.nextUrl.searchParams;
    const start = sp.get('start');
    const end = sp.get('end');
    if (!start || !end || !ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
      return NextResponse.json({ error: 'start and end query params are required as YYYY-MM-DD' }, { status: 400 });
    }

    const headers = await listHeaders(start, end);
    return NextResponse.json({ headers });
  } catch (error) {
    console.error('[payroll/runs GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to list payroll runs';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
