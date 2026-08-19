/**
 * QuickBooks Online "Import journal entries" CSV builder (Barbara, 2026-08-19: she imports
 * the JEs herself via Settings -> Import data -> Journal entries, bypassing the Post button).
 * Pure — drafts in, rows out — and deliberately free of everything the review .xlsx carries
 * that QBO's importer must not see: no TOTAL row, no banner note, no Account #/Origin columns.
 *
 * Format notes (QBO importer contract — mirrors Intuit's sample_journalentry_import.csv
 * byte-for-byte on headers so the wizard auto-maps every field):
 *  - columns: *JournalNo,*JournalDate,*AccountName,*Debits,*Credits,Description,Name,Currency,
 *    Location,Class (asterisks are part of the template's header text; there is NO Memo column —
 *    the wizard cannot import a JE-level private note);
 *  - rows sharing a JournalNo group into one JE, so a split run ships every piece in ONE file;
 *  - JournalDate (MM/DD/YYYY — set the wizard's date-format selector to match) and Currency
 *    ('USD') appear only on each JE's FIRST row, exactly like the sample;
 *  - AccountName is the bare FullyQualifiedName with ':' sub-account separators. ⚠ QBO's
 *    import wizard DOES NOT WORK while "Enable account numbers" is on — its own import guide
 *    says to turn the setting off first (verified 2026-08-19: bare names fail with numbers on,
 *    and numbered names `<AcctNum> <FQN>` fail too — there is NO file format that satisfies the
 *    wizard with numbers enabled);
 *  - amounts are plain 2dp numbers, Debits XOR Credits per row;
 *  - Location carries the department, Class the class; Name (per-line payee) stays blank.
 *  - ONE FILE = ONE QBO COMPANY: never mix entities in a single CSV.
 */
import type { JournalLine } from './types';
import type { ExportColumn, CellValue } from '../inventory-export';
import { compareJournalLines } from './line-order';

export const QBO_IMPORT_COLUMNS: ExportColumn[] = [
  { header: '*JournalNo', key: 'journalNo' },
  { header: '*JournalDate', key: 'journalDate' },
  { header: '*AccountName', key: 'accountName' },
  { header: '*Debits', key: 'debits' },
  { header: '*Credits', key: 'credits' },
  { header: 'Description', key: 'description' },
  { header: 'Name', key: 'name' },
  { header: 'Currency', key: 'currency' },
  { header: 'Location', key: 'location' },
  { header: 'Class', key: 'className' },
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

export function buildQboImportRows(jes: QboImportJe[]): Record<string, CellValue>[] {
  const rows: Record<string, CellValue>[] = [];
  for (const je of jes) {
    const date = isoToQboDate(je.txnDateIso);
    const ordered = [...je.lines].sort(compareJournalLines);
    ordered.forEach((l, i) => {
      rows.push({
        journalNo: je.docNumber,
        // Date + currency only on the JE's first row, mirroring Intuit's sample file.
        journalDate: i === 0 ? date : '',
        accountName: l.accountName,
        debits: l.postingType === 'Debit' ? round2(l.amount).toFixed(2) : '',
        credits: l.postingType === 'Credit' ? round2(l.amount).toFixed(2) : '',
        description: l.memo,
        name: '',
        currency: i === 0 ? 'USD' : '',
        location: l.departmentName ?? '',
        className: l.className ?? '',
      });
    });
  }
  return rows;
}

/** filesystem-safe basename (no extension): QBO_Import_<entity>_<first doc># [+n more]. */
export function qboImportFilename(entity: string, jes: QboImportJe[]): string {
  const stem = jes.length === 1 ? jes[0].docNumber : `${jes[0].docNumber}_and_${jes.length - 1}_more`;
  return `QBO_Import_${entity}_${stem}`.replace(/[^A-Za-z0-9._-]+/g, '_');
}
