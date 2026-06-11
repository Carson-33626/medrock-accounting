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

export async function xlsxResponse(
  sheets: Array<{
    name: string;
    columns: ExportColumn[];
    rows: Record<string, CellValue>[];
  }>,
  filename: string,
  note: string,
): Promise<NextResponse> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MedRock Accounting';

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name);

    const noteRow = ws.addRow([note]);
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

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(Buffer.from(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
    },
  });
}
