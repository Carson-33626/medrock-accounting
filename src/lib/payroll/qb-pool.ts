/**
 * Month-end allocation pool: every QB line coded to the Allocate flag (class family
 * `Allocate - *` and/or department `% Allocation`) during a month. Pure extraction from
 * raw QBO entity JSON (testable) + a thin fetch that queries JournalEntry / Purchase /
 * Bill / VendorCredit per company. See spec §4.1.
 */
import type { Entity } from './types';
import { qbQueryAll } from '../quickbooks-multi';
import { getRdsPool } from '../rds';
import { monthEndIso, type Month } from './month';
import { deriveJeIdentity } from './je-identity';
import { EOM_ENTITIES } from './revenue-rule';

export type PoolRule = 'revenue' | 'thirds' | 'fifty' | 'passthrough' | 'unknown';

export interface PoolLine {
  entity: Entity;
  txnType: string;
  txnId: string;
  txnDate: string;
  docNumber: string | null;
  accountName: string;
  className: string | null;
  departmentName: string | null;
  memo: string | null;
  amount: number; // signed dollars: costs +, refunds/credits -
  rule: PoolRule;
  counterparty: Entity | null; // fifty: the 50/50 partner; passthrough: the 100% target
}

const ALLOC_DEPT = '% Allocation';
const SHORT_TO_ENTITY: Record<string, Entity> = { FL: 'MedRock FL', TN: 'MedRock TN', TX: 'MedRock TX' };

/** Class/department -> split rule. Returns null when the line is not Allocate-flagged.
 *  Unrecognized `Allocate*` classes (and self-referential ones) come back as 'unknown'
 *  so they surface on the tab instead of being silently split or dropped. */
export function classifyAllocateFlag(
  className: string | null, departmentName: string | null, holder: Entity,
): { rule: PoolRule; counterparty: Entity | null } | null {
  if (className) {
    if (className === 'Allocate - %') return { rule: 'revenue', counterparty: null };
    if (className === 'Allocate - SplitX3') return { rule: 'thirds', counterparty: null };
    const fifty = /^Allocate - Split (FL|TN|TX)50$/.exec(className);
    if (fifty) {
      const cp = SHORT_TO_ENTITY[fifty[1]];
      return cp === holder ? { rule: 'unknown', counterparty: null } : { rule: 'fifty', counterparty: cp };
    }
    const full = /^Allocate - (FL|TN|TX)$/.exec(className);
    if (full) {
      const cp = SHORT_TO_ENTITY[full[1]];
      return cp === holder ? { rule: 'unknown', counterparty: null } : { rule: 'passthrough', counterparty: cp };
    }
    if (className.startsWith('Allocate')) return { rule: 'unknown', counterparty: null };
  }
  if (departmentName === ALLOC_DEPT) return { rule: 'revenue', counterparty: null };
  return null;
}

/**
 * QBO sometimes bakes the account NUMBER into a transaction line's AccountRef.name
 * ("6820.15 Telecommunications & Data -:Phone Expense") while the Account entity's
 * FullyQualifiedName — which fetchDimensions keys resolution on — has no number.
 * Strip a leading dotted-number prefix so pool lines carry the resolvable name and
 * both spellings of the same account net into one group. Account names in this COA
 * never legitimately start with a digit.
 */
export function normalizeAccountName(name: string): string {
  return name.replace(/^\d+(?:\.\d+)*\s+/, '');
}

// ── Raw QBO shapes (only the fields we read) ──
export interface QbRef { value?: string; name?: string }
export interface RawJeLine {
  Id?: string; Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: 'Debit' | 'Credit'; AccountRef?: QbRef; DepartmentRef?: QbRef; ClassRef?: QbRef };
}
export interface RawJournalEntry { Id: string; DocNumber?: string; TxnDate?: string; Line?: RawJeLine[] }
export interface RawExpenseLine {
  Id?: string; Amount?: number; Description?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: QbRef; ClassRef?: QbRef };
  ItemBasedExpenseLineDetail?: { ItemRef?: QbRef; ClassRef?: QbRef };
}
export interface RawExpenseTxn {
  Id: string; DocNumber?: string; TxnDate?: string; Credit?: boolean;
  DepartmentRef?: QbRef; Line: RawExpenseLine[];
}

export function poolLinesFromJournalEntry(je: RawJournalEntry, entity: Entity): PoolLine[] {
  const out: PoolLine[] = [];
  for (const l of je.Line ?? []) {
    const d = l.JournalEntryLineDetail;
    if (!d?.AccountRef?.name) continue;
    const cls = classifyAllocateFlag(d.ClassRef?.name ?? null, d.DepartmentRef?.name ?? null, entity);
    if (!cls) continue;
    const sign = d.PostingType === 'Credit' ? -1 : 1;
    out.push({
      entity, txnType: 'JournalEntry', txnId: je.Id, txnDate: je.TxnDate ?? '', docNumber: je.DocNumber ?? null,
      accountName: normalizeAccountName(d.AccountRef.name), className: d.ClassRef?.name ?? null, departmentName: d.DepartmentRef?.name ?? null,
      memo: l.Description ?? null, amount: sign * (l.Amount ?? 0), rule: cls.rule, counterparty: cls.counterparty,
    });
  }
  return out;
}

export function poolLinesFromExpenseTxn(
  txn: RawExpenseTxn, entity: Entity, txnType: 'Purchase' | 'Bill' | 'VendorCredit',
): PoolLine[] {
  const headerDept = txn.DepartmentRef?.name ?? null;
  const sign = txnType === 'VendorCredit' || txn.Credit === true ? -1 : 1;
  const out: PoolLine[] = [];
  for (const l of txn.Line ?? []) {
    const acct = l.AccountBasedExpenseLineDetail;
    const item = l.ItemBasedExpenseLineDetail;
    const lineClass = acct?.ClassRef?.name ?? item?.ClassRef?.name ?? null;
    const cls = classifyAllocateFlag(lineClass, headerDept, entity);
    if (!cls) continue;
    if (!acct?.AccountRef?.name) {
      // Item-based (or account-less) line under an Allocate flag: no expense account to
      // repost against — surface it, never guess.
      out.push({
        entity, txnType, txnId: txn.Id, txnDate: txn.TxnDate ?? '', docNumber: txn.DocNumber ?? null,
        accountName: '(item-based line)', className: lineClass, departmentName: headerDept,
        memo: l.Description ?? null, amount: sign * (l.Amount ?? 0), rule: 'unknown', counterparty: null,
      });
      continue;
    }
    out.push({
      entity, txnType, txnId: txn.Id, txnDate: txn.TxnDate ?? '', docNumber: txn.DocNumber ?? null,
      accountName: normalizeAccountName(acct.AccountRef.name), className: lineClass, departmentName: headerDept,
      memo: l.Description ?? null, amount: sign * (l.Amount ?? 0), rule: cls.rule, counterparty: cls.counterparty,
    });
  }
  return out;
}

// ── Local (unposted) payroll draft lines ──
// The pool's QB queries only see POSTED transactions, but our payroll JEs live as local
// drafts until an accountant posts them — without this, an entire month of Allocate-tagged
// wages is invisible to the EOM tab. One flat row per tagged line of an unposted
// pay_date/accrual/reversal header whose txn_date falls in the month.
export interface LocalDraftLineRow {
  header_id: string;
  entity: Entity;
  pay_date: string;
  txn_date: string | null;
  posting_type: 'Debit' | 'Credit';
  amount: string;
  account_name: string;
  department_name: string | null;
  class_name: string | null;
  memo: string | null;
}

/** Local draft line -> PoolLine (null when untagged). txnType 'DraftJE' deliberately has no
 *  QBO deep link — the transaction only exists in our store until posted. */
export function poolLineFromLocalDraftRow(r: LocalDraftLineRow, docNumber?: string): PoolLine | null {
  const cls = classifyAllocateFlag(r.class_name, r.department_name, r.entity);
  if (!cls) return null;
  const sign = r.posting_type === 'Credit' ? -1 : 1;
  return {
    entity: r.entity, txnType: 'DraftJE', txnId: r.header_id, txnDate: r.txn_date ?? '',
    docNumber: docNumber ?? `draft ${r.pay_date}`, accountName: normalizeAccountName(r.account_name),
    className: r.class_name, departmentName: r.department_name, memo: r.memo,
    amount: sign * Number(r.amount), rule: cls.rule, counterparty: cls.counterparty,
  };
}

interface LocalDraftQueryRow extends LocalDraftLineRow {
  kind: string;
  pay_group: string;
  period_segment: string;
  period_start: string | null;
  period_end: string | null;
  qb_doc_number: string | null;
  seg_index: string;
  seg_count: string;
}

/** Tagged lines from UNPOSTED local payroll drafts dated in the month. Posted headers are
 *  excluded because their live QB JEs already arrive via the QB queries — including both
 *  would double-count the month the accountant posts payroll. The same guard covers MANUAL
 *  posting (Barbara importing the QBO CSV herself): an import keeps the CSV's JournalNo, so
 *  any local draft whose derived DocNumber already exists among the month's QB journal
 *  entries for that entity is dropped as externally posted.
 *  `qbJeDocNumbers` keys are `entity¦DocNumber`, collected from the month's QB JE fetch. */
async function fetchLocalDraftPool(start: string, end: string, qbJeDocNumbers: Set<string>): Promise<PoolLine[]> {
  // seg_index/seg_count over ALL siblings of a run (not just the month's) so a straddling
  // run's pieces derive the same suffixed DocNumbers the export and post routes use.
  const { rows } = await getRdsPool().query<LocalDraftQueryRow>(
    `WITH sibs AS (
       SELECT id, entity, kind, pay_date, pay_group, period_segment, period_start, period_end,
              txn_date, qb_doc_number, status,
              (COUNT(*) OVER (PARTITION BY entity, pay_date, pay_group))::int AS seg_count,
              (ROW_NUMBER() OVER (PARTITION BY entity, pay_date, pay_group ORDER BY period_segment) - 1)::int AS seg_index
       FROM accounting.payroll_journal_headers
       WHERE kind IN ('pay_date', 'accrual', 'reversal')
     )
     SELECT h.id::text AS header_id, h.entity, h.pay_date, h.txn_date::text AS txn_date,
            h.kind, h.pay_group, h.period_segment, h.period_start, h.period_end, h.qb_doc_number,
            h.seg_index::text AS seg_index, h.seg_count::text AS seg_count,
            l.posting_type, l.amount::text AS amount, l.account_name, l.department_name, l.class_name, l.memo
       FROM accounting.payroll_journal_lines l
       JOIN sibs h ON h.id = l.header_id
      WHERE h.status <> 'posted'
        AND h.entity = ANY($1::text[])
        AND h.txn_date >= $2::date AND h.txn_date <= $3::date
        AND (l.class_name LIKE 'Allocate%' OR l.department_name = '% Allocation')`,
    [EOM_ENTITIES, start, end],
  );
  const docByHeader = new Map<string, string>();
  const out: PoolLine[] = [];
  for (const r of rows) {
    let doc: string | undefined = docByHeader.get(r.header_id);
    if (doc === undefined) {
      doc = deriveJeIdentity(
        { entity: r.entity, kind: r.kind, pay_date: r.pay_date, pay_group: r.pay_group,
          period_segment: r.period_segment, period_start: r.period_start, period_end: r.period_end,
          txn_date: r.txn_date, qb_doc_number: r.qb_doc_number },
        Number(r.seg_index), Number(r.seg_count),
      ).docNumber;
      docByHeader.set(r.header_id, doc);
    }
    if (qbJeDocNumbers.has(`${r.entity}¦${doc}`)) continue; // externally posted — QB copy already in the pool
    const pl = poolLineFromLocalDraftRow(r, doc);
    if (pl) out.push(pl);
  }
  return out;
}

/** Pull the month's pool from all three companies + local unposted payroll drafts. Throws
 *  when any company is disconnected (partial pools would silently under-allocate). */
export async function fetchAllocationPool(m: Month): Promise<{ pool: PoolLine[]; attention: PoolLine[] }> {
  const start = `${m.year}-${String(m.month).padStart(2, '0')}-01`;
  const end = monthEndIso(m);
  const where = `WHERE TxnDate >= '${start}' AND TxnDate <= '${end}'`;
  const all: PoolLine[] = [];
  // Every QB JE DocNumber seen this month, keyed entity¦doc — the externally-posted guard:
  // a local draft whose derived DocNumber is already live in QB (Barbara imported the CSV
  // herself) must not ALSO contribute its lines.
  const qbJeDocNumbers = new Set<string>();
  for (const entity of EOM_ENTITIES) {
    const [jes, purchases, bills, vendorCredits] = [
      await qbQueryAll<RawJournalEntry>(entity, 'JournalEntry', where),
      await qbQueryAll<RawExpenseTxn>(entity, 'Purchase', where),
      await qbQueryAll<RawExpenseTxn>(entity, 'Bill', where),
      await qbQueryAll<RawExpenseTxn>(entity, 'VendorCredit', where),
    ];
    for (const je of jes) {
      if (je.DocNumber) qbJeDocNumbers.add(`${entity}¦${je.DocNumber}`);
      all.push(...poolLinesFromJournalEntry(je, entity));
    }
    for (const p of purchases) all.push(...poolLinesFromExpenseTxn(p, entity, 'Purchase'));
    for (const b of bills) all.push(...poolLinesFromExpenseTxn(b, entity, 'Bill'));
    for (const v of vendorCredits) all.push(...poolLinesFromExpenseTxn(v, entity, 'VendorCredit'));
  }
  all.push(...await fetchLocalDraftPool(start, end, qbJeDocNumbers));
  const pool = all.filter((l) => l.rule === 'revenue' || l.rule === 'thirds' || l.rule === 'fifty');
  const attention = all.filter((l) => l.rule === 'passthrough' || l.rule === 'unknown');
  return { pool, attention };
}
