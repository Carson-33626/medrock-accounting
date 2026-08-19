/**
 * QuickBooks Online "Import journal entries" CSV builder (Barbara, 2026-08-19: she imports
 * the JEs herself via Settings -> Import data -> Journal entries, bypassing the Post button).
 * Pure — drafts in, rows out — and deliberately free of everything the review .xlsx carries
 * that QBO's importer must not see: no TOTAL row, no banner note, no Account #/Origin columns.
 *
 * Format notes (QBO importer contract):
 *  - rows sharing a JournalNo group into one JE, so a split run ships every piece in ONE file;
 *  - JournalDate is MM/DD/YYYY (the wizard's date-format selector must match);
 *  - AccountName is the account's NUMBERED display name — `<AcctNum> <FullyQualifiedName>`
 *    (e.g. '2115 Accrued Payroll Liability', '6500.05 Payroll Expense -:Administrative Wages').
 *    Our books run with "Enable account numbers" ON, and in that mode the wizard matches the
 *    numbered display name and rejects bare names as "Line Account invalid" (Barbara,
 *    2026-08-19; the format mirrors how QBO itself renders AccountRef.name on transactions).
 *    Accounts with no number (or when the QB lookup fails) fall back to the bare FQN.
 *  - amounts are plain 2dp numbers, Debits XOR Credits per row;
 *  - Location carries the department, Class the class, Memo the JE-level PrivateNote.
 *  - ONE FILE = ONE QBO COMPANY: never mix entities in a single CSV.
 */
import type { JournalLine } from './types';
import type { ExportColumn, CellValue } from '../inventory-export';
import { compareJournalLines } from './line-order';

export const QBO_IMPORT_COLUMNS: ExportColumn[] = [
  { header: 'JournalNo', key: 'journalNo' },
  { header: 'JournalDate', key: 'journalDate' },
  { header: 'AccountName', key: 'accountName' },
  { header: 'Debits', key: 'debits' },
  { header: 'Credits', key: 'credits' },
  { header: 'Description', key: 'description' },
  { header: 'Location', key: 'location' },
  { header: 'Class', key: 'className' },
  { header: 'Memo', key: 'memo' },
];

export interface QboImportJe {
  docNumber: string;
  /** ISO YYYY-MM-DD; rendered as MM/DD/YYYY in the file. */
  txnDateIso: string;
  privateNote: string | null;
  lines: JournalLine[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** '2026-07-31' -> '07/31/2026'. Throws on a malformed date rather than emitting a row QBO
 *  would silently mis-parse. */
export function isoToQboDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/** `<AcctNum> <FQN>` when the account carries a number — the display name QBO's import
 *  wizard matches while "Enable account numbers" is on; bare FQN otherwise. */
export function qboImportAccountName(accountName: string, accountNums?: Record<string, string>): string {
  const num = accountNums?.[accountName];
  return num ? `${num} ${accountName}` : accountName;
}

export function buildQboImportRows(jes: QboImportJe[], accountNums?: Record<string, string>): Record<string, CellValue>[] {
  const rows: Record<string, CellValue>[] = [];
  for (const je of jes) {
    const date = isoToQboDate(je.txnDateIso);
    const ordered = [...je.lines].sort(compareJournalLines);
    for (const l of ordered) {
      rows.push({
        journalNo: je.docNumber,
        journalDate: date,
        accountName: qboImportAccountName(l.accountName, accountNums),
        debits: l.postingType === 'Debit' ? round2(l.amount).toFixed(2) : '',
        credits: l.postingType === 'Credit' ? round2(l.amount).toFixed(2) : '',
        description: l.memo,
        location: l.departmentName ?? '',
        className: l.className ?? '',
        memo: je.privateNote ?? '',
      });
    }
  }
  return rows;
}

/** filesystem-safe basename (no extension): QBO_Import_<entity>_<first doc># [+n more]. */
export function qboImportFilename(entity: string, jes: QboImportJe[]): string {
  const stem = jes.length === 1 ? jes[0].docNumber : `${jes[0].docNumber}_and_${jes.length - 1}_more`;
  return `QBO_Import_${entity}_${stem}`.replace(/[^A-Za-z0-9._-]+/g, '_');
}
