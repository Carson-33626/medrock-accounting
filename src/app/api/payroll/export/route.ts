import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { loadDraft, listSiblings } from '@/lib/payroll/store';
import { buildJeExportSheet, buildRunJeExportWorkbook, type JeExportPiece } from '@/lib/payroll/je-export';
import { fetchDimensions } from '@/lib/payroll/qb-journal';
import { pieceDocNumber } from '@/lib/payroll/split';
import { POSTABLE_ENTITIES } from '@/lib/payroll/entity';
import type { Entity } from '@/lib/payroll/types';
import { xlsxResponse } from '@/lib/inventory-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payroll/export?headerId=123 — download the draft JE as an .xlsx (Barbara's request:
 * a dry-run artifact to review/circulate before posting to QuickBooks). Read-only: loads the
 * persisted draft and streams a spreadsheet of its lines. No QuickBooks WRITE.
 *
 * `&scope=run` exports the WHOLE run the header belongs to: for a split payroll that is one
 * sheet per month piece (each its own postable JE) plus a Combined review sheet. Barbara's
 * 2026-08-18 report — "the combined download is half the report, and every split downloads the
 * same file" — was this route only ever exporting the single header the panel had loaded.
 *
 * Barbara also asked the sheet to show the QBO account number next to each mapped account name.
 * Account numbers live in QuickBooks (fetchDimensions().accountNums), so we do a read-only lookup
 * best-effort: if QuickBooks is unreachable the export still streams, just with blank Account #.
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
    const scope = request.nextUrl.searchParams.get('scope');

    const siblings = await listSiblings(header.entity, header.pay_date, header.pay_group);

    // Best-effort QB account-number lookup (read-only). Never let a QuickBooks hiccup block the
    // dry-run export — degrade to blank Account # instead.
    let accountNums: Record<string, string> | undefined;
    if ((POSTABLE_ENTITIES as string[]).includes(header.entity)) {
      try {
        const refs = await fetchDimensions(header.entity as Entity);
        accountNums = refs.accountNums;
      } catch (dimErr) {
        console.warn('[payroll/export GET] account-number lookup skipped:', dimErr instanceof Error ? dimErr.message : dimErr);
      }
    }

    if (scope === 'run' && siblings.length > 1) {
      // Whole run: load every sibling piece so a split payroll exports complete, never half.
      const pieces: JeExportPiece[] = await Promise.all(
        siblings.map(async (s, i): Promise<JeExportPiece> => {
          const piece = s.id === headerId ? loaded : await loadDraft(s.id);
          if (!piece) throw new Error(`split piece ${s.id} (${s.period_segment}) could not be loaded`);
          return {
            header: piece.header,
            lines: piece.lines,
            periodSegment: piece.header.period_segment,
            docNumber: pieceDocNumber(header.pay_date, siblings.length, i),
            txnDate: piece.header.txn_date ?? '',
          };
        }),
      );
      const workbook = buildRunJeExportWorkbook(pieces, accountNums);
      return xlsxResponse(workbook.sheets, workbook.filename, workbook.sheets[0].note);
    }

    const overrides = siblings.length > 1
      ? {
          docNumber: pieceDocNumber(header.pay_date, siblings.length, Math.max(0, siblings.findIndex((s) => s.id === headerId))),
          txnDate: header.txn_date ?? '',
        }
      : undefined;

    const sheet = buildJeExportSheet(header, lines, accountNums, overrides);
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
