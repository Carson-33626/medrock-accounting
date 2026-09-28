/**
 * Month-end allocation adjustments keyed straight into QuickBooks, outside the app.
 *
 * Barbara, 2026-09-28: "the tool only searches for the JE that comes from it". She fixed April
 * with a hand-keyed `% Allo 2026.04B` in all three companies, but the difference check and the
 * correction generator netted only the entries this app posted — so April kept flagging a
 * difference the books no longer had, and Generate correction would have re-booked it.
 *
 * WHAT COUNTS. A QuickBooks journal entry that (a) carries a doc number in the month's
 * allocation family — `% Allo YYYY.MM`, optionally prefixed by the state (`FL `) and suffixed by
 * a letter or `-n` (`% Allo 2026.04B`, `FL % Allo 2026.04-2`) — (b) is dated inside that month,
 * and (c) is not one of this app's own entries (its QuickBooks id is on no header). The family
 * match is deliberately narrow: `CS Allo`, `Inv Adj`, `Ship Pkg Adj` and the Ramp split
 * allocations never match, and an entry named for one month but dated in another (a `2026.05B`
 * dated in October) is left out rather than guessed at.
 */
import { getRdsPool } from '../rds';
import { qbQueryAll } from '../quickbooks-multi';
import { monthEndIso, type Month } from './month';
import type { Entity, JournalLine, PostingType } from './types';

/** One QuickBooks journal entry line, as the query API returns it. */
interface QbJournalLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: PostingType;
    AccountRef?: { name?: string };
    DepartmentRef?: { name?: string };
    ClassRef?: { name?: string };
  };
}

export interface QbJournalEntry {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  Line?: QbJournalLine[];
}

/** A hand-keyed allocation adjustment, ready to net. */
export interface ManualEomAdjustment {
  qbEntryId: string;
  docNumber: string;
  lines: JournalLine[];
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** True when `docNumber` is in month `m`'s `% Allo` family (see file header). */
export function isEomAllocationDoc(docNumber: string | undefined, m: Month): boolean {
  if (docNumber === undefined) return false;
  const re = new RegExp(`^(?:(?:FL|TN|TX)\\s+)?%\\s*Allo\\s+${m.year}\\.${pad2(m.month)}(?:[A-Z]|-\\d+)?$`, 'i');
  return re.test(docNumber.trim());
}

/** QuickBooks lines -> the app's line shape. Account names match the app's verbatim. */
export function qbJournalToLines(je: QbJournalEntry): JournalLine[] {
  const out: JournalLine[] = [];
  for (const l of je.Line ?? []) {
    const d = l.JournalEntryLineDetail;
    const accountName = d?.AccountRef?.name;
    if (d?.PostingType === undefined || accountName === undefined) continue;
    out.push({
      postingType: d.PostingType,
      amount: Math.round((l.Amount ?? 0) * 100) / 100,
      accountName,
      departmentName: d.DepartmentRef?.name ?? null,
      className: d.ClassRef?.name ?? null,
      memo: l.Description ?? '',
      creditBucket: null,
      origin: 'manual',
      sourceRowKeys: [],
    });
  }
  return out;
}

/** Pure filter: month-family, dated in the month, not one of the app's own entries. */
export function selectManualEomAdjustments(
  entries: readonly QbJournalEntry[], m: Month, appQbIds: ReadonlySet<string>,
): ManualEomAdjustment[] {
  const first = `${m.year}-${pad2(m.month)}-01`;
  const last = monthEndIso(m);
  return entries
    .filter((je) => !appQbIds.has(je.Id))
    .filter((je) => isEomAllocationDoc(je.DocNumber, m))
    .filter((je) => je.TxnDate !== undefined && je.TxnDate >= first && je.TxnDate <= last)
    .sort((a, b) => Number(a.Id) - Number(b.Id))
    .map((je) => ({ qbEntryId: je.Id, docNumber: je.DocNumber ?? '', lines: qbJournalToLines(je) }));
}

/** Every QuickBooks id this app has ever posted for the entity. */
async function appQbEntryIds(entity: Entity): Promise<Set<string>> {
  const { rows } = await getRdsPool().query<{ qb_entry_id: string }>(
    `SELECT qb_entry_id FROM accounting.payroll_journal_headers WHERE entity = $1 AND qb_entry_id IS NOT NULL`,
    [entity],
  );
  return new Set(rows.map((r) => r.qb_entry_id));
}

/**
 * The hand-keyed allocation adjustments for one entity/month, read live from QuickBooks.
 * Throws when QuickBooks cannot be read — callers must not net without them.
 */
export async function listManualEomAdjustments(m: Month, entity: Entity): Promise<ManualEomAdjustment[]> {
  const first = `${m.year}-${pad2(m.month)}-01`;
  const [entries, appIds] = await Promise.all([
    qbQueryAll<QbJournalEntry>(entity, 'JournalEntry', `WHERE TxnDate >= '${first}' AND TxnDate <= '${monthEndIso(m)}'`),
    appQbEntryIds(entity),
  ]);
  return selectManualEomAdjustments(entries, m, appIds);
}
