import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { loadDraft } from '@/lib/payroll/store';
import { buildJeExportSheet } from '@/lib/payroll/je-export';
import { xlsxResponse } from '@/lib/inventory-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payroll/export?headerId=123 — download the draft JE as an .xlsx (Barbara's request:
 * a dry-run artifact to review/circulate before posting to QuickBooks). Read-only: loads the
 * persisted draft and streams a spreadsheet of its lines. No QuickBooks write, no QB round-trip.
 */
export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const headerId = Number(request.nextUrl.searchParams.get('headerId'));
    if (!Number.isFinite(headerId) || headerId <= 0) {
      return NextResponse.json({ error: 'headerId is required' }, { status: 400 });
    }

    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }

    const { header, lines } = loaded;
    const sheet = buildJeExportSheet(header, lines);
    return xlsxResponse(
      [{ name: 'Journal Entry', columns: sheet.columns, rows: sheet.rows }],
      sheet.filename,
      sheet.note,
    );
  } catch (error) {
    console.error('[payroll/export GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to export journal entry';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
