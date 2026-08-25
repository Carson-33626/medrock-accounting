/**
 * Month-end allocation pool: every QB line coded to the Allocate flag (class family
 * `Allocate - *` and/or department `% Allocation`) during a month. Pure extraction from
 * raw QBO entity JSON (testable) + a thin fetch that queries JournalEntry / Purchase /
 * Bill / VendorCredit / Deposit per company. See spec §4.1. Deposits joined 2026-08-19
 * for the revenue true-up class-splits; passthrough pools from Deposits/JEs/local drafts
 * and stays out of the pool only where QBO auto-books it (see isPooledLine).
 */
import type { Entity } from './types';
import { qbQueryAll } from '../quickbooks-multi';
import { getRdsPool } from '../rds';
import { monthEndIso, type Month } from './month';
import { deriveJeIdentity } from './je-identity';
import { EOM_ENTITIES } from './revenue-rule';
import { allocateClassFor, isPoolClass } from './mapping';
import { costCenterFor } from './cost-center';

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
  /** True only for lines re-derived from OUR posted payroll's source rows
   *  (poolLineFromPostedOwnedRow) — their cost-center attribution is exact, unlike QB
   *  extraction lines, whose frozen tags follow the accountant's tag-everything-'%'
   *  convention. Consumers that need per-cost-center precision (the CS-only catch-up)
   *  key on this. */
  ownedPayroll?: boolean;
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
  // A bare '% Allocation' department with no class: shared cost, but not Customer Service —
  // and per Ash (2026-08-25) only CS follows revenue; "everything else is by 1/3".
  if (departmentName === ALLOC_DEPT) return { rule: 'thirds', counterparty: null };
  return null;
}

/** Dept-only MARKETING lines (Barbara's convention put marketers under the '% Allocation'
 *  department with no class). Ash 2026-08-25: "marketing is already going to where they're
 *  employed so marketing does not need to be split" — these lines are already booked at the
 *  right entity and must not enter the pool OR the attention list. Directed marketer classes
 *  (`Allocate - TX`) are untouched: those encode an explicit routing decision and keep
 *  working as passthrough. */
export function isMarketingStayHomeLine(l: PoolLine): boolean {
  // Commission Wages is a marketer-only account (sales reps): Barbara books marketer
  // commissions dept-only the same way as their base wages.
  return l.className === null && l.departmentName === ALLOC_DEPT &&
    /marketing|commission wages/i.test(l.accountName);
}

/** The Customer-Service slice of the pool — what the CS-only catch-up allocates by revenue,
 *  and what the full month-end must EXCLUDE for a month whose CS is already posted
 *  separately (see eom-store.listPostedCsAlloHeaders). Three sources, three trust levels:
 *  ownedPayroll lines and DraftJE lines carry exact per-pay-period cost-center attribution,
 *  so rule='revenue' IS Customer Service (admin derives SplitX3, marketing never pools);
 *  external QB JEs follow the accountant's tag-everything-'%' convention — and her
 *  recurring re-class JEs carry 'PR'-prefixed docs — so only Customer-Service-named
 *  accounts are accepted from them. */
export function isCsPoolLine(l: PoolLine): boolean {
  if (l.rule !== 'revenue') return false;
  if (l.ownedPayroll === true || l.txnType === 'DraftJE') return true;
  return l.txnType === 'JournalEntry' && /^PR /.test(l.docNumber ?? '') && /customer service/i.test(l.accountName);
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

// ── Deposits (revenue class-splits) ──
// The 2026-08-19 revenue true-up split TRUIST MERCHANT deposit revenue lines into
// class-tagged lines ('Allocate - TX/TN/FL' on the foreign shares). QBO's Intercompany
// allocation does NOT react to deposit lines (verified: zero auto-JEs after 213 splits),
// so month-end is what moves this revenue — unlike Bill/Purchase passthrough, which QBO
// auto-books per transaction and must never be pooled (it would double-move).
export interface RawDepositLine {
  Id?: string; Amount?: number; Description?: string;
  DepositLineDetail?: { AccountRef?: QbRef; ClassRef?: QbRef };
}
export interface RawDeposit { Id: string; DocNumber?: string; TxnDate?: string; Line?: RawDepositLine[] }

export function poolLinesFromDeposit(dep: RawDeposit, entity: Entity): PoolLine[] {
  const out: PoolLine[] = [];
  for (const l of dep.Line ?? []) {
    const d = l.DepositLineDetail;
    if (!d?.AccountRef?.name) continue;
    const cls = classifyAllocateFlag(d.ClassRef?.name ?? null, null, entity);
    if (!cls) continue;
    // A deposit line CREDITS its account (revenue), so the pool amount is negative —
    // the same "credits are negative" convention every other source uses.
    out.push({
      entity, txnType: 'Deposit', txnId: dep.Id, txnDate: dep.TxnDate ?? '', docNumber: dep.DocNumber ?? null,
      accountName: normalizeAccountName(d.AccountRef.name), className: d.ClassRef?.name ?? null, departmentName: null,
      memo: l.Description ?? null, amount: -(l.Amount ?? 0), rule: cls.rule, counterparty: cls.counterparty,
    });
  }
  return out;
}

/** Which lines the JE generator consumes (the rest surface on the attention list).
 *  revenue/thirds/fifty pool from every source. passthrough pools from Deposits,
 *  JournalEntries, and local payroll drafts — nothing else moves those (verified
 *  2026-08-19: zero auto-JEs after 213 deposit class-splits; no JE-triggered
 *  auto-move ever observed). It stays OUT of the pool for Bill/Purchase/
 *  VendorCredit, where QBO's Intercompany allocation auto-books the move on the
 *  transaction itself within minutes (verified pairs, e.g. FL Bill 52277 ↔ FL JE
 *  1521041161 + TN JE 1521040386) — pooling those would move the money twice. */
const QBO_AUTOBOOKED_TXN_TYPES = new Set(['Purchase', 'Bill', 'VendorCredit']);
export function isPooledLine(l: PoolLine): boolean {
  if (l.rule === 'revenue' || l.rule === 'thirds' || l.rule === 'fifty') return true;
  return l.rule === 'passthrough' && !QBO_AUTOBOOKED_TXN_TYPES.has(l.txnType);
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

/**
 * True when a local draft's derived DocNumber is already represented among the month's
 * posted QB journal entries for its entity — the accountant posted this payroll outside
 * the tool, so the draft's lines would count the same wages twice.
 *
 * Exact equality is not enough (found 2026-08-25: $36,314.06 double-counted in March's
 * pool). Barbara posts a month-crossing run as ONE combined JE (`PR 2026.03.13`) while the
 * local run is split into suffixed pieces (`PR 2026.03.13A`/`B`), and she annotates
 * off-cycle runs (`PR 2026.03.09 OffCycl`) where the derivation says `PR 2026.03.09`.
 * For pay_date drafts the match is therefore on the run's BASE doc — the derived doc with
 * any trailing split letter stripped — accepting a QB doc equal to that base or extending
 * it with a space-separated annotation. A QB doc extending the base with a DIFFERENT split
 * letter does not match: piece A being posted says nothing about piece B.
 *
 * Accrual/reversal docs stay exact-match only: `PR Accru 2026.03` and its reversal
 * `PR Accru 2026.03R` differ by one trailing letter and are different journal entries.
 */
export function isExternallyPostedDoc(derivedDoc: string, kind: string, qbDocs: ReadonlySet<string>): boolean {
  if (qbDocs.has(derivedDoc)) return true;
  if (kind !== 'pay_date') return false;
  const base = derivedDoc.replace(/[A-Z]$/, '');
  if (base !== derivedDoc && qbDocs.has(base)) return true;
  for (const qb of qbDocs) {
    if (qb.startsWith(`${base} `)) return true;
  }
  return false;
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
 *  posting (Barbara keying or importing the JE herself): a draft whose derived DocNumber is
 *  already represented in QB for its entity is dropped as externally posted — see
 *  isExternallyPostedDoc for what "represented" means beyond exact equality.
 *  `qbJeDocsByEntity` holds the month's QB JE DocNumbers per entity. */
async function fetchLocalDraftPool(
  start: string, end: string, qbJeDocsByEntity: ReadonlyMap<Entity, ReadonlySet<string>>,
): Promise<PoolLine[]> {
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
    const qbDocs = qbJeDocsByEntity.get(r.entity);
    if (qbDocs && isExternallyPostedDoc(doc, r.kind, qbDocs)) continue; // externally posted — QB copy already in the pool
    const pl = poolLineFromLocalDraftRow(r, doc);
    if (pl) out.push(pl);
  }
  return out;
}

// ── Posted-by-our-tool payroll: re-derive tags from source data ──
// A posted JE's Allocate tags are FROZEN at post time. April–July 2026 payroll was posted
// before CS/ADMIN/ACCOUN tagging derived from the pay-period cost center, so the QB copies
// carry stale tags: CS wages untagged (an entire month of CS labor invisible to the pool)
// while a promoted employee's shipping lines stayed wrongly tagged. Rather than reading the
// frozen tags, headers OUR tool posted are re-attributed here from their lines' source
// payroll rows — home_department is per pay period, so the attribution is always what the
// CURRENT mapping rules say. Their QB copies are suppressed from the QB extraction (matched
// on the header's stored qb_doc_number) so nothing counts twice. Manually-posted entries
// (Barbara's) have no local lines and keep flowing through their QB tags.

export interface PostedOwnedLineRow {
  entity: Entity;
  kind: string;
  qb_doc_number: string;
  qb_entry_id: string | null;
  txn_date: string | null;
  posting_type: 'Debit' | 'Credit';
  amount: string;
  account_name: string;
  department_name: string | null;
  class_name: string | null;
  memo: string | null;
  /** DISTINCT home_department values of the line's source payroll rows. */
  depts: string[] | null;
}

/**
 * Posted-owned line -> PoolLine, re-tagged from the pay-period cost center (null when the
 * line does not belong in the pool). Sign follows double-entry structure per kind:
 * pay_date/accrual JEs carry allocated cost on their DEBIT lines (credits are withholdings /
 * net pay / the accrual's liability credit — never pool those); a reversal JE carries it on
 * its CREDIT lines, entering negative. A line whose source rows span more than one cost
 * center is skipped — attribution would be a guess, and the grouping memo convention makes
 * this rare.
 */
export function poolLineFromPostedOwnedRow(r: PostedOwnedLineRow): PoolLine | null {
  const wantPosting = r.kind === 'reversal' ? 'Credit' : 'Debit';
  if (r.posting_type !== wantPosting) return null;
  const ccs = [...new Set((r.depts ?? []).map((d) => costCenterFor(d)))];
  if (ccs.length !== 1) return null;
  const cc = ccs[0];
  const derivedClass = allocateClassFor(cc, r.class_name);
  // The stored DEPARTMENT is frozen tagging too: a stale `Allocate - %` came paired with the
  // `% Allocation` dept, and the bare dept alone re-admits a line to the pool. Reconstruct it
  // like the class — pair it with a derived pool class, strip it everywhere else. That
  // includes MARKET: Ash confirmed 2026-08-25 marketing stays with the employing entity, so
  // the dept-only marketers' frozen `% Allocation` dept no longer pools their lines.
  const dept = isPoolClass(derivedClass) ? '% Allocation'
    : r.department_name === '% Allocation' ? null
    : r.department_name;
  const cls = classifyAllocateFlag(derivedClass, dept, r.entity);
  if (!cls) return null;
  const sign = r.posting_type === 'Credit' ? -1 : 1;
  return {
    entity: r.entity, txnType: 'JournalEntry', txnId: r.qb_entry_id ?? '', txnDate: r.txn_date ?? '',
    docNumber: r.qb_doc_number, accountName: normalizeAccountName(r.account_name),
    className: derivedClass, departmentName: dept, memo: r.memo,
    amount: sign * Number(r.amount), rule: cls.rule, counterparty: cls.counterparty,
    ownedPayroll: true,
  };
}

/** Pool lines for POSTED payroll headers our tool wrote to QB, re-tagged from source rows,
 *  plus the per-entity set of their QB DocNumbers (for suppressing the QB copies). */
async function fetchPostedOwnedPool(
  start: string, end: string,
): Promise<{ lines: PoolLine[]; ownedDocs: Map<Entity, Set<string>> }> {
  const { rows } = await getRdsPool().query<PostedOwnedLineRow>(
    `WITH owned AS (
       SELECT id, entity, kind, qb_doc_number, qb_entry_id, txn_date
       FROM accounting.payroll_journal_headers
       WHERE status = 'posted' AND kind IN ('pay_date', 'accrual', 'reversal')
         AND qb_doc_number IS NOT NULL
         AND entity = ANY($1::text[])
         AND txn_date >= $2::date AND txn_date <= $3::date
     )
     SELECT o.entity, o.kind, o.qb_doc_number, o.qb_entry_id, o.txn_date::text AS txn_date,
            l.posting_type, l.amount::text AS amount, l.account_name, l.department_name,
            l.class_name, l.memo,
            (SELECT array_agg(DISTINCT ph.home_department)
               FROM source.payroll_history ph
              WHERE ph.row_key = ANY(l.source_row_keys)) AS depts
       FROM accounting.payroll_journal_lines l
       JOIN owned o ON o.id = l.header_id
      WHERE l.origin = 'generated' AND cardinality(l.source_row_keys) > 0`,
    [EOM_ENTITIES, start, end],
  );
  const lines: PoolLine[] = [];
  const ownedDocs = new Map<Entity, Set<string>>();
  for (const r of rows) {
    const docs = ownedDocs.get(r.entity) ?? new Set<string>();
    docs.add(r.qb_doc_number.trim());
    ownedDocs.set(r.entity, docs);
    const pl = poolLineFromPostedOwnedRow(r);
    if (pl) lines.push(pl);
  }
  return { lines, ownedDocs };
}

/** Pull the month's pool from all three companies + local unposted payroll drafts. Throws
 *  when any company is disconnected (partial pools would silently under-allocate). */
export async function fetchAllocationPool(m: Month): Promise<{ pool: PoolLine[]; attention: PoolLine[] }> {
  const start = `${m.year}-${String(m.month).padStart(2, '0')}-01`;
  const end = monthEndIso(m);
  const where = `WHERE TxnDate >= '${start}' AND TxnDate <= '${end}'`;
  const all: PoolLine[] = [];
  // Headers our tool posted: their pool lines come re-tagged from source rows, and their
  // QB copies are skipped below (frozen tags would double-count or mis-tag them).
  const { lines: postedOwned, ownedDocs } = await fetchPostedOwnedPool(start, end);
  all.push(...postedOwned);
  // Every QB JE DocNumber seen this month, per entity — the externally-posted guard's
  // input: a local draft whose run is already live in QB (Barbara posted it herself)
  // must not ALSO contribute its lines. See isExternallyPostedDoc.
  const qbJeDocsByEntity = new Map<Entity, Set<string>>();
  for (const entity of EOM_ENTITIES) {
    const qbDocs = new Set<string>();
    qbJeDocsByEntity.set(entity, qbDocs);
    const owned = ownedDocs.get(entity);
    const [jes, purchases, bills, vendorCredits, deposits] = [
      await qbQueryAll<RawJournalEntry>(entity, 'JournalEntry', where),
      await qbQueryAll<RawExpenseTxn>(entity, 'Purchase', where),
      await qbQueryAll<RawExpenseTxn>(entity, 'Bill', where),
      await qbQueryAll<RawExpenseTxn>(entity, 'VendorCredit', where),
      await qbQueryAll<RawDeposit>(entity, 'Deposit', where),
    ];
    for (const je of jes) {
      const doc = je.DocNumber?.trim();
      if (doc) qbDocs.add(doc);
      // Our posted copy of this JE is already in the pool, re-tagged from source rows —
      // reading the QB copy's frozen tags on top would double-count it.
      if (doc && owned?.has(doc)) continue;
      all.push(...poolLinesFromJournalEntry(je, entity));
    }
    for (const p of purchases) all.push(...poolLinesFromExpenseTxn(p, entity, 'Purchase'));
    for (const b of bills) all.push(...poolLinesFromExpenseTxn(b, entity, 'Bill'));
    for (const v of vendorCredits) all.push(...poolLinesFromExpenseTxn(v, entity, 'VendorCredit'));
    for (const dep of deposits) all.push(...poolLinesFromDeposit(dep, entity));
  }
  all.push(...await fetchLocalDraftPool(start, end, qbJeDocsByEntity));
  // Marketing stays with its employer (Ash 2026-08-25) — see isMarketingStayHomeLine.
  const kept = all.filter((l) => !isMarketingStayHomeLine(l));
  const pool = kept.filter(isPooledLine);
  const attention = kept.filter((l) => !isPooledLine(l) && (l.rule === 'passthrough' || l.rule === 'unknown'));
  return { pool, attention };
}
