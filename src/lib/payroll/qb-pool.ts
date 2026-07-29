/**
 * Month-end allocation pool: every QB line coded to the Allocate flag (class family
 * `Allocate - *` and/or department `% Allocation`) during a month. Pure extraction from
 * raw QBO entity JSON (testable) + a thin fetch that queries JournalEntry / Purchase /
 * Bill / VendorCredit per company. See spec §4.1.
 */
import type { Entity } from './types';
import { qbQueryAll } from '../quickbooks-multi';
import { monthEndIso, type Month } from './month';
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
      accountName: d.AccountRef.name, className: d.ClassRef?.name ?? null, departmentName: d.DepartmentRef?.name ?? null,
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
      accountName: acct.AccountRef.name, className: lineClass, departmentName: headerDept,
      memo: l.Description ?? null, amount: sign * (l.Amount ?? 0), rule: cls.rule, counterparty: cls.counterparty,
    });
  }
  return out;
}

/** Pull the month's pool from all three companies. Throws when any company is
 *  disconnected (partial pools would silently under-allocate). */
export async function fetchAllocationPool(m: Month): Promise<{ pool: PoolLine[]; attention: PoolLine[] }> {
  const start = `${m.year}-${String(m.month).padStart(2, '0')}-01`;
  const end = monthEndIso(m);
  const where = `WHERE TxnDate >= '${start}' AND TxnDate <= '${end}'`;
  const all: PoolLine[] = [];
  for (const entity of EOM_ENTITIES) {
    const [jes, purchases, bills, vendorCredits] = [
      await qbQueryAll<RawJournalEntry>(entity, 'JournalEntry', where),
      await qbQueryAll<RawExpenseTxn>(entity, 'Purchase', where),
      await qbQueryAll<RawExpenseTxn>(entity, 'Bill', where),
      await qbQueryAll<RawExpenseTxn>(entity, 'VendorCredit', where),
    ];
    for (const je of jes) all.push(...poolLinesFromJournalEntry(je, entity));
    for (const p of purchases) all.push(...poolLinesFromExpenseTxn(p, entity, 'Purchase'));
    for (const b of bills) all.push(...poolLinesFromExpenseTxn(b, entity, 'Bill'));
    for (const v of vendorCredits) all.push(...poolLinesFromExpenseTxn(v, entity, 'VendorCredit'));
  }
  const pool = all.filter((l) => l.rule === 'revenue' || l.rule === 'thirds' || l.rule === 'fifty');
  const attention = all.filter((l) => l.rule === 'passthrough' || l.rule === 'unknown');
  return { pool, attention };
}
