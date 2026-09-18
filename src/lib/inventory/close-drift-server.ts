/**
 * The reads behind the close drift check and the ordering gates (`close-drift.ts`).
 *
 * Read-only against QuickBooks (balance sheets, chart, SELECT queries) and RDS.
 * See docs/fifo-monthly-close/ds-close-drift-guard-2026-09-18.md.
 */
import type { Pool } from 'pg';
import { getRdsPool } from '../rds';
import { getBalanceSheetInventory, qbQueryAll, type Location } from '../quickbooks-multi';
import { QB_LOCATIONS, QB_TO_RDS_LOCATION } from '../qb-links';
import { fetchDimensions } from '../payroll/qb-journal';
import type { Entity } from '../payroll/types';
import { fetchCategoryLedgerValues } from './ledger-values';
import {
  buildCategoryJE,
  buildCategoryRollForward,
  CUTOVER_MONTH,
  INV_CLOSE_PAY_GROUP,
  INV_OPEN_PAY_GROUP,
  type CategoryLedgerValue,
} from './monthly-close';
import {
  correctionOrderReason,
  driftStatuses,
  postOrderReason,
  DRIFT_TOLERANCE,
  type CloseHeaderRef,
  type DriftStatus,
  type MonthGap,
} from './close-drift';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Last day of 'YYYY-MM', ISO. */
function monthEndOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Every stored INV CLOSE / INV OPEN header with its generate and post stamps. */
export async function listCloseHeaderRefs(entity?: Entity): Promise<CloseHeaderRef[]> {
  const { rows } = await getRdsPool().query<{
    id: string;
    entity: string;
    period_end: string | null;
    txn_date: string | null;
    period_segment: string;
    status: string;
    qb_doc_number: string | null;
    generated_at: string | null;
    posted_at: string | null;
  }>(
    `SELECT h.id::text, h.entity, h.period_end::text, to_char(h.txn_date,'YYYY-MM-DD') AS txn_date,
            h.period_segment, h.status, h.qb_doc_number,
            (SELECT to_char(max(a.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
               FROM accounting.payroll_post_audit a WHERE a.header_id = h.id AND a.outcome = 'generated') AS generated_at,
            (SELECT to_char(max(a.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
               FROM accounting.payroll_post_audit a WHERE a.header_id = h.id AND a.outcome = 'posted') AS posted_at
       FROM accounting.payroll_journal_headers h
      WHERE h.kind = 'inventory' AND h.pay_group = ANY($1::text[])
        AND ($2::text IS NULL OR h.entity = $2)`,
    [[INV_CLOSE_PAY_GROUP, INV_OPEN_PAY_GROUP], entity ?? null],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    entity: r.entity,
    month: (r.period_end ?? r.txn_date ?? '').slice(0, 7),
    segment: r.period_segment,
    status: r.status,
    docNumber: r.qb_doc_number,
    generatedAt: r.generated_at,
    postedAt: r.posted_at,
  }));
}

export interface CategoryGap {
  category: string;
  inventoryAccount: string;
  fifo: number;
  book: number | null;
  /** FIFO − book: what a correction would book on this category. */
  gap: number;
}

/**
 * FIFO − book per category for one entity at one month-end, exactly as the close computes it
 * (same ledger read, same balance-sheet read, same `buildCategoryJE`). null when the book
 * could not be read.
 */
export async function entityCategoryGaps(
  pool: Pool,
  entity: Entity,
  month: string,
  ledgerCache?: Map<string, CategoryLedgerValue[]>,
): Promise<CategoryGap[] | null> {
  const location = QB_TO_RDS_LOCATION[entity as keyof typeof QB_TO_RDS_LOCATION];
  if (location === undefined) return null;
  let ledger = ledgerCache?.get(month);
  if (ledger === undefined) {
    ledger = await fetchCategoryLedgerValues(pool, month);
    ledgerCache?.set(month, ledger);
  }
  const rollForward = buildCategoryRollForward(ledger, null);
  const [book, refs] = await Promise.all([
    getBalanceSheetInventory(entity as Location, monthEndOf(month)).catch(() => null),
    fetchDimensions(entity).catch(() => null),
  ]);
  if (book === null || refs === null) return null;
  const je = buildCategoryJE(location, rollForward, book.accounts, refs.accountNums ?? {}, true);
  return je.lines.map((l) => ({
    category: l.qbCategory,
    inventoryAccount: l.inventoryAccount,
    fifo: l.fifoTarget,
    book: l.qbBookBalance,
    gap: l.adjustment ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Late entries: QuickBooks activity dated inside a closed month but keyed after its close.
// ---------------------------------------------------------------------------

interface QbLine {
  Amount?: number;
  AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string } };
  ItemBasedExpenseLineDetail?: { ItemRef?: { value?: string } };
  JournalEntryLineDetail?: { PostingType?: 'Debit' | 'Credit'; AccountRef?: { value?: string } };
  DepositLineDetail?: { AccountRef?: { value?: string } };
}

interface QbDoc {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  Credit?: boolean;
  VendorRef?: { name?: string };
  EntityRef?: { name?: string };
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
  Line?: QbLine[];
}

/** One document's net effect on one inventory account (asset increase = +). */
export interface AccountTouch {
  type: string;
  docId: string;
  docNumber: string;
  txnDate: string;
  name: string;
  account: string;
  amount: number;
  createdAt: string;
  updatedAt: string;
}

const LATE_TYPES: readonly string[] = ['Bill', 'Purchase', 'JournalEntry', 'VendorCredit', 'Deposit'];

/** Our own close entries: 'FL Inv Adj 2026.08', '… -2', 'TN Inv Open 2025.12'. */
const OWN_CLOSE_DOC = /^(FL|TN|TX) Inv (Adj|Open) \d{4}\.\d{2}(-\d+)?$/;

/** Signed per-account effects of one document, rolled up to one row per account. */
export function documentTouches(
  type: string,
  doc: QbDoc,
  accountName: ReadonlyMap<string, string>,
  itemAsset: ReadonlyMap<string, string>,
): AccountTouch[] {
  const sign = type === 'VendorCredit' || (type === 'Purchase' && doc.Credit === true) ? -1 : 1;
  const byAccount = new Map<string, number>();
  const add = (acct: string | undefined, amount: number): void => {
    if (acct === undefined) return;
    byAccount.set(acct, (byAccount.get(acct) ?? 0) + amount);
  };
  for (const l of doc.Line ?? []) {
    const amt = l.Amount ?? 0;
    add(l.AccountBasedExpenseLineDetail?.AccountRef?.value, sign * amt);
    const item = l.ItemBasedExpenseLineDetail?.ItemRef?.value;
    add(item === undefined ? undefined : itemAsset.get(item), sign * amt);
    const j = l.JournalEntryLineDetail;
    if (j !== undefined) add(j.AccountRef?.value, j.PostingType === 'Credit' ? -amt : amt);
    add(l.DepositLineDetail?.AccountRef?.value, -amt);
  }
  const out: AccountTouch[] = [];
  for (const [acct, amount] of byAccount) {
    if (Math.abs(amount) < 0.005) continue;
    out.push({
      type,
      docId: doc.Id,
      docNumber: doc.DocNumber ?? '',
      txnDate: doc.TxnDate ?? '',
      name: doc.VendorRef?.name ?? doc.EntityRef?.name ?? '',
      account: accountName.get(acct) ?? acct,
      amount: round2(amount),
      createdAt: doc.MetaData?.CreateTime ?? '',
      updatedAt: doc.MetaData?.LastUpdatedTime ?? '',
    });
  }
  return out;
}

/** Every inventory-account touch on documents modified since `sinceIso`, our own entries excluded. */
async function fetchTouchesSince(entity: Entity, sinceIso: string): Promise<AccountTouch[]> {
  const location = entity as Location;
  const [accounts, items] = await Promise.all([
    qbQueryAll<{ Id: string; FullyQualifiedName?: string }>(location, 'Account', ''),
    qbQueryAll<{ Id: string; AssetAccountRef?: { value?: string } }>(location, 'Item', ''),
  ]);
  const accountName = new Map(accounts.map((a) => [a.Id, a.FullyQualifiedName ?? a.Id]));
  const itemAsset = new Map<string, string>();
  for (const it of items) if (it.AssetAccountRef?.value) itemAsset.set(it.Id, it.AssetAccountRef.value);
  const out: AccountTouch[] = [];
  for (const type of LATE_TYPES) {
    const docs = await qbQueryAll<QbDoc>(location, type, `WHERE MetaData.LastUpdatedTime >= '${sinceIso}'`);
    for (const doc of docs) {
      if (OWN_CLOSE_DOC.test(doc.DocNumber ?? '')) continue;
      out.push(...documentTouches(type, doc, accountName, itemAsset));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The drift report.
// ---------------------------------------------------------------------------

export interface DriftCategoryRow extends CategoryGap {
  late: number;
  fifoMoved: number;
  editedDocs: number;
}

export interface DriftMonthRow {
  entity: Entity;
  month: string;
  /** The month's posted entries, oldest first ('FL Inv Adj 2026.08', '… -2'). */
  postedDocs: string[];
  /** When the month's latest entry posted — the "after" in late entries. */
  lastPostedAt: string;
  gap: number;
  late: number;
  fifoMoved: number;
  editedDocs: number;
  status: DriftStatus;
  /** The ordering reason, for `after` / `open` rows. */
  blockedBy: string | null;
  categories: DriftCategoryRow[];
  /** Largest late entries, for the reviewer. */
  lateEntries: AccountTouch[];
  /** The book could not be read — no gap, no status. */
  unavailable: boolean;
}

export interface DriftReport {
  asOf: string;
  months: DriftMonthRow[];
}

const LATE_LIST = 12;

/** The drift report for every posted monthly close, per company. */
export async function fetchCloseDrift(): Promise<DriftReport> {
  const pool = getRdsPool();
  const headers = await listCloseHeaderRefs();
  const ledgerCache = new Map<string, CategoryLedgerValue[]>();
  const months: DriftMonthRow[] = [];

  for (const entity of QB_LOCATIONS as Entity[]) {
    const own = headers.filter((h) => h.entity === entity && h.month >= CUTOVER_MONTH);
    const postedMonths = [...new Set(own.filter((h) => h.status === 'posted' && h.segment === '').map((h) => h.month))].sort();
    if (postedMonths.length === 0) continue;

    const lastPosted = new Map<string, string>();
    for (const m of postedMonths) {
      const stamps = own.filter((h) => h.month === m && h.postedAt !== null).map((h) => h.postedAt as string);
      lastPosted.set(m, stamps.sort()[stamps.length - 1]);
    }
    const since = [...lastPosted.values()].sort()[0];
    const touches = await fetchTouchesSince(entity, since).catch((error: Error) => {
      console.warn(`[close-drift] ${entity} late-entry scan failed:`, error.message);
      return [] as AccountTouch[];
    });

    const rows: DriftMonthRow[] = [];
    for (const month of postedMonths) {
      const monthEnd = monthEndOf(month);
      const postedAt = lastPosted.get(month) ?? since;
      const gaps = await entityCategoryGaps(pool, entity, month, ledgerCache);
      const inMonth = touches.filter((t) => t.txnDate !== '' && t.txnDate <= monthEnd);
      const lateAll = inMonth.filter((t) => Date.parse(t.createdAt) > Date.parse(postedAt));
      const editedAll = inMonth.filter(
        (t) => Date.parse(t.createdAt) <= Date.parse(postedAt) && Date.parse(t.updatedAt) > Date.parse(postedAt),
      );
      const categories: DriftCategoryRow[] = (gaps ?? []).map((g) => {
        const late = round2(lateAll.filter((t) => t.account === g.inventoryAccount).reduce((s, t) => s + t.amount, 0));
        return {
          ...g,
          late,
          fifoMoved: round2(g.gap + late),
          editedDocs: new Set(editedAll.filter((t) => t.account === g.inventoryAccount).map((t) => t.docId)).size,
        };
      });
      const accounts = new Set(categories.map((c) => c.inventoryAccount));
      const lateEntries = lateAll
        .filter((t) => accounts.has(t.account))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
        .slice(0, LATE_LIST);
      const gap = round2(categories.reduce((s, c) => s + c.gap, 0));
      const late = round2(categories.reduce((s, c) => s + c.late, 0));
      rows.push({
        entity,
        month,
        postedDocs: own
          .filter((h) => h.month === month && h.status === 'posted')
          .sort((a, b) => a.segment.localeCompare(b.segment))
          .map((h) => h.docNumber ?? `#${h.id}`),
        lastPostedAt: postedAt,
        gap,
        late,
        fifoMoved: round2(gap + late),
        editedDocs: categories.reduce((s, c) => s + c.editedDocs, 0),
        status: 'ties',
        blockedBy: null,
        categories,
        lateEntries,
        unavailable: gaps === null,
      });
    }

    const statuses = driftStatuses(
      rows
        .filter((r) => !r.unavailable)
        .map((r) => ({
          month: r.month,
          gap: r.gap,
          openCorrection: own.some((h) => h.month === r.month && /^C\d+$/.test(h.segment) && h.status !== 'posted'),
        })),
    );
    let first: DriftMonthRow | null = null;
    for (const r of rows) {
      r.status = statuses.get(r.month) ?? 'ties';
      if (first === null && (r.status === 'correct' || r.status === 'open')) first = r;
      if (r.status === 'after' && first !== null) r.blockedBy = `correct ${first.month} first`;
      if (r.status === 'open') {
        const draft = own.find((h) => h.month === r.month && /^C\d+$/.test(h.segment) && h.status !== 'posted');
        r.blockedBy = `${draft?.docNumber ?? 'a correction draft'} is waiting to be posted or discarded`;
      }
    }
    months.push(...rows);
  }
  return { asOf: new Date().toISOString(), months };
}

// ---------------------------------------------------------------------------
// Gates used by the correction generator and the post route.
// ---------------------------------------------------------------------------

/** Why a correction for (entity, month) must wait, or null. Reads earlier months' gaps live. */
export async function correctionOrderLock(entity: Entity, month: string): Promise<string | null> {
  const headers = await listCloseHeaderRefs(entity);
  const earlierPosted = [
    ...new Set(
      headers
        .filter((h) => h.month >= CUTOVER_MONTH && h.month < month && h.segment === '' && h.status === 'posted')
        .map((h) => h.month),
    ),
  ].sort();
  // Cheap check first: an open earlier correction blocks without reading any balance sheet.
  const cheap = correctionOrderReason(entity, month, headers, []);
  if (cheap !== null) return cheap;
  const pool = getRdsPool();
  const cache = new Map<string, CategoryLedgerValue[]>();
  const gaps: MonthGap[] = [];
  for (const m of earlierPosted) {
    const cats = await entityCategoryGaps(pool, entity, m, cache);
    if (cats === null) return `${entity}: the ${m} book balance could not be read — cannot confirm earlier months tie`;
    const gap = round2(cats.reduce((s, c) => s + c.gap, 0));
    gaps.push({ month: m, gap });
    // Oldest first: the first gapped month is the answer, no need to read further.
    if (Math.abs(gap) >= DRIFT_TOLERANCE) break;
  }
  return correctionOrderReason(entity, month, headers, gaps);
}

/** Why header `headerId` must not post live, or null. */
export async function postOrderLock(headerId: number, entity: Entity): Promise<string | null> {
  const headers = await listCloseHeaderRefs(entity);
  const target = headers.find((h) => h.id === headerId);
  if (target === undefined) return null;
  return postOrderReason(target, headers);
}
