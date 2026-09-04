/** READ-ONLY: does the JE export actually produce a valid workbook?
 *
 *  Kristi clicks the Excel attached to the 3/31/2026 PR Accru JE in QuickBooks and gets
 *  "File or directory not found". Barbara says our tool generated that file. This exercises
 *  the SAME builders /api/payroll/export uses, serialises with the same ExcelJS settings as
 *  lib/inventory-export.xlsxResponse, writes each workbook to disk and parses it back.
 *
 *  Distinguishes three failure modes:
 *    - a builder throws, or emits an empty/corrupt file  -> our bug
 *    - the builders are fine                             -> the QB attachment is the problem
 *    - loadDraft returns null for the id                 -> a stale download link
 *
 *  No writes to the DB or QuickBooks. Untracked scratch.
 */
import './load-env-vercel-first';
import { writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { getRdsPool } from '../../src/lib/rds';
import { loadDraft, listSiblings } from '../../src/lib/payroll/store';
import { buildRunJeExportWorkbook, buildJeExportSheet, type JeExportPiece } from '../../src/lib/payroll/je-export';
import { pieceDocNumber } from '../../src/lib/payroll/split';
import { deriveJeIdentity } from '../../src/lib/payroll/je-identity';
import type { CellValue, ExportColumn } from '../../src/lib/inventory-export';

interface HeaderRow { id: number; entity: string; pay_date: string; kind: string; status: string; pay_group: string }

/** Mirrors lib/inventory-export.xlsxResponse, minus the NextResponse wrapper. */
async function toXlsxBuffer(
  sheets: Array<{ name: string; columns: ExportColumn[]; rows: Record<string, CellValue>[]; note?: string }>,
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
    for (const row of sheet.rows) ws.addRow(sheet.columns.map((c) => row[c.key] ?? null));
    sheet.columns.forEach((col, idx) => {
      const column = ws.getColumn(idx + 1);
      column.width = Math.max(col.header.length + 2, 14);
      if (col.currency) column.numFmt = '$#,##0.00';
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function main(): Promise<void> {
  const monthArg = process.argv[2] ?? '2026-03';
  const outDir = process.argv[3] ?? '.';
  const [y, mo] = monthArg.split('-');
  const pool = getRdsPool();

  const rows = await pool.query<HeaderRow>(
    `SELECT id, entity, pay_date, kind, status, pay_group
       FROM accounting.payroll_journal_headers
      WHERE to_date(pay_date,'MM/DD/YYYY') BETWEEN DATE '${y}-${mo}-01'
            AND (DATE '${y}-${mo}-01' + INTERVAL '1 month - 1 day')
      ORDER BY to_date(pay_date,'MM/DD/YYYY'), entity, id`,
  );
  console.log(`\n=== ${monthArg}: ${rows.rows.length} headers (every kind) ===`);
  for (const h of rows.rows) {
    console.log(`  #${h.id} ${h.pay_date} ${h.entity.padEnd(12)} kind=${h.kind.padEnd(9)} status=${h.status.padEnd(12)} group=${h.pay_group}`);
  }

  let ok = 0;
  let bad = 0;
  for (const h of rows.rows) {
    const label = `#${h.id} ${h.entity} ${h.kind}`;
    try {
      const loaded = await loadDraft(h.id);
      if (!loaded) { console.log(`\n  !! ${label}: loadDraft returned null — a link to this id would 404`); bad++; continue; }
      const { header, lines } = loaded;
      const siblings = await listSiblings(header.entity, header.pay_date, header.pay_group);

      let buf: Buffer;
      let shapeNote: string;
      if (siblings.length > 1) {
        const pieces: JeExportPiece[] = [];
        for (let i = 0; i < siblings.length; i++) {
          const s = siblings[i];
          const piece = s.id === h.id ? loaded : await loadDraft(s.id);
          if (!piece) throw new Error(`split piece ${s.id} could not be loaded`);
          pieces.push({
            header: piece.header, lines: piece.lines,
            periodSegment: piece.header.period_segment,
            docNumber: pieceDocNumber(header.pay_date, siblings.length, i),
            txnDate: piece.header.txn_date ?? '',
          });
        }
        const wb = buildRunJeExportWorkbook(pieces, undefined);
        buf = await toXlsxBuffer(wb.sheets, wb.sheets[0].note);
        shapeNote = `run scope, ${pieces.length} pieces -> ${wb.sheets.length} sheets, ${wb.filename}.xlsx`;
      } else {
        const overrides = header.kind !== 'pay_date'
          ? (() => { const id = deriveJeIdentity(header, 0, 1); return { docNumber: id.docNumber, txnDate: id.txnDateIso }; })()
          : undefined;
        const sheet = buildJeExportSheet(header, lines, undefined, overrides);
        buf = await toXlsxBuffer([{ name: 'Journal Entry', columns: sheet.columns, rows: sheet.rows }], sheet.note);
        shapeNote = `single sheet, doc ${sheet.docNumber}, ${sheet.rows.length} lines, ${sheet.filename}.xlsx`;
      }

      const path = resolve(outDir, `export-${h.id}-${h.entity.replace(/\W+/g, '')}-${h.kind}.xlsx`);
      writeFileSync(path, buf);
      const size = statSync(path).size;
      const magic = buf.subarray(0, 2).toString('latin1'); // a real .xlsx is a ZIP -> 'PK'

      const rb = new ExcelJS.Workbook();
      await rb.xlsx.load(buf as unknown as ArrayBuffer);
      const sheets = rb.worksheets.map((w) => `${w.name}(${w.rowCount}r)`).join(', ');
      const rowTotal = rb.worksheets.reduce((s, w) => s + w.rowCount, 0);

      const good = magic === 'PK' && size > 0 && rowTotal > 2;
      if (good) ok++; else bad++;
      console.log(`\n  ${good ? 'OK ' : 'BAD'} ${label}`);
      console.log(`       ${shapeNote}`);
      console.log(`       ${size} bytes, magic=${magic}, reparsed sheets: ${sheets}`);
      console.log(`       -> ${path}`);
    } catch (err) {
      bad++;
      console.log(`\n  !! ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n=== ${ok} healthy, ${bad} problem(s) ===`);
  await pool.end();
  process.exit(0);
}

void main();
