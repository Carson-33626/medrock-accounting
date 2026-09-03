/**
 * The one workbook a journal entry ships with: its `Journal Entry` sheet plus every
 * source-detail sheet its kind has.
 *
 * ONE assembler, two surfaces — `/api/payroll/export` streams it to the browser and
 * `je-attach` uploads the same bytes to the posted entry in QuickBooks. Carson, 2026-09-03:
 * *"I need all journal entry pieces to attach the journal entry sheet plus all source details
 * in an excel."* Two builders that merely ought to agree is how the download and the
 * attachment drift apart, so there is only this one.
 */
import type { ExportSheet } from '@/lib/inventory-export';
import { buildJeExportSheet } from './je-export';
import { fetchJeDetailSheets } from './je-detail-fetch';
import { fetchDimensions } from './qb-journal';
import { POSTABLE_ENTITIES } from './entity';
import type { PayrollHeader } from './store';
import type { Entity, JournalLine } from './types';

export interface AssembledJeWorkbook {
  sheets: ExportSheet[];
  /** filesystem-safe basename, no extension. */
  filename: string;
  note: string;
  docNumber: string;
  txnDate: string;
}

export interface JeWorkbookOptions {
  /** FullyQualifiedName -> QB AcctNum. Looked up best-effort when absent. */
  accountNums?: Record<string, string>;
  /** Kind-aware DocNumber/TxnDate, when the caller has already derived them. */
  overrides?: { docNumber: string; txnDate: string };
  /** Skip the QuickBooks account-number lookup (the caller already tried, or is offline). */
  skipAccountNums?: boolean;
}

/**
 * Best-effort account numbers: Barbara asked the export to show the QBO account NUMBER next
 * to each name, but a QuickBooks hiccup must never block a download or an attachment — the
 * cell goes blank instead.
 */
async function lookupAccountNums(entity: Entity): Promise<Record<string, string> | undefined> {
  if (!(POSTABLE_ENTITIES as readonly string[]).includes(entity)) return undefined;
  try {
    return (await fetchDimensions(entity)).accountNums;
  } catch (error) {
    console.warn('[je-workbook] account-number lookup skipped:', error instanceof Error ? error.message : error);
    return undefined;
  }
}

export async function buildJeSourceWorkbook(
  header: PayrollHeader,
  lines: readonly JournalLine[],
  opts: JeWorkbookOptions = {},
): Promise<AssembledJeWorkbook> {
  const accountNums = opts.accountNums ?? (opts.skipAccountNums ? undefined : await lookupAccountNums(header.entity));
  const sheet = buildJeExportSheet(header, [...lines], accountNums, opts.overrides);

  const label = `${header.entity} — ${sheet.docNumber} — ${sheet.txnDate}`;
  const detail = await fetchJeDetailSheets(header, lines, label);

  return {
    sheets: [
      { name: 'Journal Entry', columns: sheet.columns, rows: sheet.rows },
      ...detail,
    ],
    filename: sheet.filename,
    note: sheet.note,
    docNumber: sheet.docNumber,
    txnDate: sheet.txnDate,
  };
}
