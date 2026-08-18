/**
 * Builds the sheet model for the payroll JE Excel export (Barbara's request: a dry-run
 * artifact she can eyeball / circulate BEFORE anyone posts to QuickBooks). Pure + testable:
 * takes the persisted draft (header info + lines) and returns columns/rows for `xlsxResponse`,
 * plus the DocNumber/TxnDate the JE would post under and a filesystem-safe filename.
 *
 * DocNumber/TxnDate reuse `qb-journal`'s derivation so the export matches the live post exactly.
 * This exports the draft as reviewed (account NAMES, memos, dept/class) — not the QB-ref-resolved
 * payload — so it never needs a QuickBooks round-trip and always works offline.
 */
import type { JournalLine } from './types';
import type { ExportColumn, CellValue } from '../inventory-export';
import { docNumber as deriveDocNumber, txnDate as deriveTxnDate } from './qb-journal';
import { compareJournalLines } from './line-order';
import { pieceLabel } from './split';

/** Minimal header shape the export needs — a subset of store.PayrollHeader. */
export interface JeExportHeader {
  entity: string;
  pay_date: string;
  pay_group: string;
  /** Set once posted; preferred over the derived DocNumber when present. */
  qb_doc_number: string | null;
}

export interface JeExportSheet {
  columns: ExportColumn[];
  rows: Record<string, CellValue>[];
  docNumber: string;
  txnDate: string;
  /** filesystem-safe basename (no extension), e.g. `JE_MedRock_FL_PR_2026.07.01`. */
  filename: string;
  /** one-line context banner for the sheet's note row. */
  note: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// Account # sits right before Account so the two read together — the accounting team works by
// account number, and Barbara asked the export to show the QBO account NAME and NUMBER it maps to.
const COLUMNS: ExportColumn[] = [
  { header: 'Type', key: 'type' },
  { header: 'Account #', key: 'acctNum' },
  { header: 'Account', key: 'account' },
  { header: 'Memo', key: 'memo' },
  { header: 'Department', key: 'department' },
  { header: 'Class', key: 'className' },
  { header: 'Debit', key: 'debit', currency: true },
  { header: 'Credit', key: 'credit', currency: true },
  { header: 'Origin', key: 'origin' },
];

/**
 * @param accountNums FullyQualifiedName -> QB account number (AcctNum), as returned by
 *   fetchDimensions().accountNums. Optional and best-effort: when absent (offline export, or an
 *   account with no number) the Account # cell is left blank rather than failing the export.
 */
export function buildJeExportSheet(
  header: JeExportHeader,
  lines: JournalLine[],
  accountNums?: Record<string, string>,
  overrides?: { docNumber: string; txnDate: string },
): JeExportSheet {
  // Group by account then memo (same order as the review table + builder) so the exported
  // sheet is readable; sort a copy so the caller's array is never mutated.
  const ordered = [...lines].sort(compareJournalLines);
  const rows: Record<string, CellValue>[] = ordered.map((l) => ({
    type: l.postingType,
    acctNum: accountNums?.[l.accountName] ?? '',
    account: l.accountName,
    memo: l.memo ?? '',
    department: l.departmentName ?? '',
    className: l.className ?? '',
    debit: l.postingType === 'Debit' ? round2(l.amount) : null,
    credit: l.postingType === 'Credit' ? round2(l.amount) : null,
    origin: l.origin,
  }));

  const totalDebits = round2(lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
  const totalCredits = round2(lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
  rows.push({ type: 'TOTAL', acctNum: '', account: '', memo: '', department: '', className: '', debit: totalDebits, credit: totalCredits, origin: '' });

  const docNumber = header.qb_doc_number ?? overrides?.docNumber ?? deriveDocNumber(header.pay_date);
  const txnDate = overrides?.txnDate ?? deriveTxnDate(header.pay_date);
  const filename = `JE_${header.entity}_${docNumber}`.replace(/[^A-Za-z0-9._-]+/g, '_');
  const variance = round2(totalDebits - totalCredits);
  const note =
    `${header.entity} - ${header.pay_group} - pay date ${header.pay_date} - DocNumber ${docNumber} - ` +
    `TxnDate ${txnDate} - debits ${totalDebits.toFixed(2)} / credits ${totalCredits.toFixed(2)} ` +
    `(variance ${variance.toFixed(2)}) - dry-run preview, NOT yet posted to QuickBooks.`;

  return { columns: COLUMNS, rows, docNumber, txnDate, filename, note };
}

// ── Whole-run workbook (split payrolls) ─────────────────────────────────────

/** One piece of a run: its persisted draft plus the piece-suffixed DocNumber/TxnDate it posts under. */
export interface JeExportPiece {
  header: JeExportHeader;
  lines: JournalLine[];
  /** 'YYYY-MM' month segment — orders the pieces and labels the sheet tab. */
  periodSegment: string;
  docNumber: string;
  txnDate: string;
}

export interface JeExportWorkbookSheet {
  name: string;
  columns: ExportColumn[];
  rows: Record<string, CellValue>[];
  note: string;
}

export interface JeExportWorkbook {
  sheets: JeExportWorkbookSheet[];
  filename: string;
}

/**
 * The download for a WHOLE run. A split payroll posts as multiple journal entries (one per
 * calendar month), and the export must contain all of them — Barbara's 2026-08-18 report was
 * exactly this: the file only ever held one piece, so the "combined" download was half the
 * payroll and every sub-tab re-downloaded that same half. Emits one sheet per piece (each a
 * postable JE with its own DocNumber/TxnDate) plus a read-only Combined sheet whose JE column
 * says which entry each line posts under. A single-piece run degrades to the plain export.
 */
export function buildRunJeExportWorkbook(
  pieces: JeExportPiece[],
  accountNums?: Record<string, string>,
): JeExportWorkbook {
  const ordered = [...pieces].sort((a, b) => a.periodSegment.localeCompare(b.periodSegment));

  const pieceSheets = ordered.map((p) => {
    const s = buildJeExportSheet(p.header, p.lines, accountNums, { docNumber: p.docNumber, txnDate: p.txnDate });
    return { sheet: s, piece: p };
  });

  if (ordered.length === 1) {
    const { sheet } = pieceSheets[0];
    return {
      sheets: [{ name: 'Journal Entry', columns: sheet.columns, rows: sheet.rows, note: sheet.note }],
      filename: sheet.filename,
    };
  }

  const sheets: JeExportWorkbookSheet[] = pieceSheets.map(({ sheet, piece }) => ({
    // Tab names stay within Excel's 31-char / no \ / ? * [ ] : rules — 'Jun (PR 2026.07.01A)'.
    name: `${pieceLabel(piece.periodSegment)} (${sheet.docNumber})`,
    columns: sheet.columns,
    rows: sheet.rows,
    note: sheet.note,
  }));

  // Combined sheet: every piece's lines (piece order preserved), tagged with the JE they post
  // under, and one TOTAL row across the whole run.
  const combinedColumns: ExportColumn[] = [{ header: 'JE', key: 'je' }, ...COLUMNS];
  const combinedRows: Record<string, CellValue>[] = pieceSheets.flatMap(({ sheet }) =>
    sheet.rows
      .filter((r) => r.type !== 'TOTAL')
      .map((r) => ({ je: sheet.docNumber, ...r })),
  );
  const allLines = ordered.flatMap((p) => p.lines);
  const totalDebits = round2(allLines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
  const totalCredits = round2(allLines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
  combinedRows.push({
    je: '', type: 'TOTAL', acctNum: '', account: '', memo: '', department: '', className: '',
    debit: totalDebits, credit: totalCredits, origin: '',
  });

  const head = ordered[0].header;
  const docNumbers = pieceSheets.map(({ sheet }) => sheet.docNumber);
  const variance = round2(totalDebits - totalCredits);
  const combinedNote =
    `${head.entity} - ${head.pay_group} - pay date ${head.pay_date} - COMBINED review view of ` +
    `${ordered.length} separate journal entries (${docNumbers.join(' + ')}), one per month - ` +
    `debits ${totalDebits.toFixed(2)} / credits ${totalCredits.toFixed(2)} (variance ${variance.toFixed(2)}) - ` +
    `this sheet is review-only; the pieces post individually.`;

  sheets.push({ name: 'Combined', columns: combinedColumns, rows: combinedRows, note: combinedNote });

  const stem = deriveDocNumber(head.pay_date);
  const filename = `JE_${head.entity}_${stem}_split`.replace(/[^A-Za-z0-9._-]+/g, '_');
  return { sheets, filename };
}
