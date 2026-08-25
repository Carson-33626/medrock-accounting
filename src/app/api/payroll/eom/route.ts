import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getEomRun, listEomHeaders, listPostedCsAlloHeaders } from '@/lib/payroll/eom-store';
import { loadDraft } from '@/lib/payroll/store';
import type { JournalLine } from '@/lib/payroll/types';
import type { Month } from '@/lib/payroll/month';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseMonthParam(raw: string | null): { month: string; m: Month } | null {
  if (!raw || !MONTH_RE.test(raw)) return null;
  const [y, mo] = raw.split('-');
  return { month: raw, m: { year: Number(y), month: Number(mo) } };
}

/**
 * GET /api/payroll/eom?month=YYYY-MM — the month's saved allocation run (pool/revenue
 * snapshot) plus its headers and each header's lines. Empty state (no run generated yet)
 * returns `run: null, headers: []` rather than 404 — the tab renders a "generate" prompt.
 */
export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const parsed = parseMonthParam(request.nextUrl.searchParams.get('month'));
    if (!parsed) {
      return NextResponse.json({ error: 'month query param is required as YYYY-MM' }, { status: 400 });
    }
    const { month, m } = parsed;

    const [run, headers, csAlloHeaders] = await Promise.all([
      getEomRun(month), listEomHeaders(m), listPostedCsAlloHeaders(m),
    ]);

    const lines: Record<string, JournalLine[]> = {};
    for (const header of headers) {
      const loaded = await loadDraft(header.id);
      lines[String(header.id)] = loaded ? loaded.lines : [];
    }

    // Posted CS-only catch-up entries (pay_group 'CS ALLO%'). Rendered as their own card:
    // for these months the pool and drafts EXCLUDE Customer Service (the generate hard
    // rule), so without this the tab would look like CS was simply missing.
    const csAlloLines: Record<string, JournalLine[]> = {};
    for (const header of csAlloHeaders) {
      const loaded = await loadDraft(header.id);
      csAlloLines[String(header.id)] = loaded ? loaded.lines : [];
    }

    return NextResponse.json({ run, headers, lines, csAllo: { headers: csAlloHeaders, lines: csAlloLines } });
  } catch (error) {
    console.error('[payroll/eom GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load month-end allocation run';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
