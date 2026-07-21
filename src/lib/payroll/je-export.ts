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

const COLUMNS: ExportColumn[] = [
  { header: 'Type', key: 'type' },
  { header: 'Account', key: 'account' },
  { header: 'Memo', key: 'memo' },
  { header: 'Department', key: 'department' },
  { header: 'Class', key: 'className' },
  { header: 'Debit', key: 'debit', currency: true },
  { header: 'Credit', key: 'credit', currency: true },
  { header: 'Origin', key: 'origin' },
];

export function buildJeExportSheet(header: JeExportHeader, lines: JournalLine[]): JeExportSheet {
  // Group by account then memo (same order as the review table + builder) so the exported
  // sheet is readable; sort a copy so the caller's array is never mutated.
  const ordered = [...lines].sort(compareJournalLines);
  const rows: Record<string, CellValue>[] = ordered.map((l) => ({
    type: l.postingType,
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
  rows.push({ type: 'TOTAL', account: '', memo: '', department: '', className: '', debit: totalDebits, credit: totalCredits, origin: '' });

  const docNumber = header.qb_doc_number ?? deriveDocNumber(header.pay_date);
  const txnDate = deriveTxnDate(header.pay_date);
  const filename = `JE_${header.entity}_${docNumber}`.replace(/[^A-Za-z0-9._-]+/g, '_');
  const variance = round2(totalDebits - totalCredits);
  const note =
    `${header.entity} - ${header.pay_group} - pay date ${header.pay_date} - DocNumber ${docNumber} - ` +
    `TxnDate ${txnDate} - debits ${totalDebits.toFixed(2)} / credits ${totalCredits.toFixed(2)} ` +
    `(variance ${variance.toFixed(2)}) - dry-run preview, NOT yet posted to QuickBooks.`;

  return { columns: COLUMNS, rows, docNumber, txnDate, filename, note };
}
