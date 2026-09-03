/**
 * Export helpers for inventory API routes: CSV and Excel (.xlsx).
 * PDF export is deferred to a later phase (spec open item).
 */

import ExcelJS from 'exceljs';
import { NextResponse } from 'next/server';

export type CellValue = string | number | boolean | null;

export interface ExportColumn {
  header: string;
  key: string;
  currency?: boolean;
}

function csvEscape(value: CellValue): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvResponse(
  columns: ExportColumn[],
  rows: Record<string, CellValue>[],
  filename: string,
): NextResponse {
  const lines: string[] = [];
  lines.push(columns.map((c) => csvEscape(c.header)).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c.key] ?? null)).join(','));
  }
  return new NextResponse(lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.csv"`,
    },
  });
}

export interface ExportSheet {
  name: string;
  columns: ExportColumn[];
  rows: Record<string, CellValue>[];
  /** Per-sheet note row; falls back to the workbook-level `note` when absent. */
  note?: string;
}

/**
 * The workbook bytes, so the browser download and the QuickBooks attachment are the
 * SAME file rather than two builders that merely ought to agree.
 *
 * `xlsxResponse` is a thin wrapper over this — the accountant who opens the download
 * and the auditor who opens the attachment on the posted entry are looking at output
 * from one code path, which is the only way that stays true as sheets get added.
 */
export async function buildXlsxBuffer(
  sheets: readonly ExportSheet[],
  note: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MedRock Accounting';

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name);

    const noteRow = ws.addRow([sheet.note ?? note]);
    noteRow.font = { italic: true, color: { argb: 'FF666666' } };
    ws.mergeCells(1, 1, 1, Math.max(sheet.columns.length, 1));

    const headerRow = ws.addRow(sheet.columns.map((c) => c.header));
    headerRow.font = { bold: true };

    for (const row of sheet.rows) {
      ws.addRow(sheet.columns.map((c) => row[c.key] ?? null));
    }

    sheet.columns.forEach((col, idx) => {
      const column = ws.getColumn(idx + 1);
      column.width = Math.max(col.header.length + 2, 14);
      if (col.currency) {
        column.numFmt = '$#,##0.00';
      }
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** The MIME type QuickBooks and browsers both use for .xlsx. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function xlsxResponse(
  sheets: readonly ExportSheet[],
  filename: string,
  note: string,
): Promise<NextResponse> {
  const buffer = await buildXlsxBuffer(sheets, note);
  // Uint8Array, not the Buffer itself: BodyInit does not admit Node's Buffer type, and the
  // view shares the same bytes rather than copying them.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
    },
  });
}
