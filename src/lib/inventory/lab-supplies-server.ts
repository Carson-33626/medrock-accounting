/**
 * The lab-supplies accrual read from QuickBooks, and turned into drafts.
 *
 * WHY THIS IS A LIB AND NOT JUST THE ROUTE
 *
 * Two surfaces need this number: the COGS tab, which displays it, and the draft
 * generator, which posts it. They must be the same number. Reading QuickBooks
 * twice through two code paths is exactly how a screen and an entry drift apart,
 * so both come through here.
 *
 * WHY IT QUERIES QUICKBOOKS DIRECTLY AND NOT THE RDS MIRROR
 *
 * `inventory.qb_documents` has no line-level account column — `line_amounts` is a
 * bare array — so "bills coded to 1220.20" is not expressible against it, and its
 * `synced_at` is a one-shot 2026-08-24 snapshot. Account-level truth only exists
 * on the QuickBooks side, and the whole formula turns on how RECENT the entry is.
 *
 * Filtered by ACCOUNT ID, never vendor name: Amazon Business alone appears under
 * two separate QuickBooks vendor records in Florida, so a name filter silently
 * loses half of it.
 *
 * Read-only against QuickBooks — SELECT queries only, nothing is written there.
 */
import { qbQueryAll, type Location } from '@/lib/quickbooks-multi';
import {
  computeAccrual, ACCRUAL_PARAMETERS,
  type AccrualLocation, type AccrualResult,
} from './lab-supplies-accrual';
import { LAB_ACCRUAL_PAY_GROUP, ACCRUED_EXPENSES_ACCOUNT } from './lab-supplies-je';
import { buildLabSuppliesContribution, LAB_SUPPLIES_SOURCE_KEY, type LabSuppliesContribution } from './lab-supplies-contribution';
import type { LabSuppliesPoolSnapshot } from './je-detail-lab-pool';
import { INV_CLOSE_PAY_GROUP } from './monthly-close';
import { getRdsPool } from '@/lib/rds';
import type { Entity } from '@/lib/payroll/types';

const ACCOUNT_NUMS = ['1220.20', '5000.25'] as const;

export const ACCRUAL_LOCATIONS: readonly AccrualLocation[] = [
  'MedRock FL',
  'MedRock TN',
  'MedRock TX',
];

interface AccountRow {
  Id: string;
  AcctNum?: string;
}

interface DocLine {
  Amount?: number;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string } };
}

interface BillDoc {
  Id: string;
  TxnDate?: string;
  Line?: DocLine[];
}

export interface LabSuppliesAccrualMonth extends AccrualResult {
  location: AccrualLocation;
  /** 'YYYY-MM' */
  month: string;
  observedToDate: number;
  observedDocs: number;
}

export interface LabSuppliesAccrualResponse {
  asOf: string;
  months: LabSuppliesAccrualMonth[];
  /** Locations whose QuickBooks realm could not be read; their rows are absent. */
  unavailable: string[];
}

/** Last day of a 'YYYY-MM', as 'YYYY-MM-DD'. */
export function monthEndOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The trailing `count` months ending with the one containing `asOf`. */
export function recentMonths(asOf: string, count: number): string[] {
  const [y, m] = asOf.split('-').map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * The accrual for the trailing `monthCount` months, every location.
 *
 * One unreachable realm must not blank the other two — it is reported in
 * `unavailable` and its rows are simply absent, which the caller can see.
 */
export async function fetchLabSuppliesAccrual(monthCount = 6): Promise<LabSuppliesAccrualResponse> {
  const asOf = new Date().toISOString().slice(0, 10);
  const months = recentMonths(asOf, monthCount);
  const from = `${months[0]}-01`;

  const rows: LabSuppliesAccrualMonth[] = [];
  const unavailable: string[] = [];

  for (const location of ACCRUAL_LOCATIONS) {
    try {
      // Resolve the two account ids for THIS realm — ids differ per company.
      const accounts = await qbQueryAll<AccountRow>(location as Location, 'Account', '');
      const wanted = new Set(
        accounts
          .filter((a) => a.AcctNum && ACCOUNT_NUMS.includes(a.AcctNum as '1220.20'))
          .map((a) => a.Id),
      );
      if (wanted.size === 0) {
        unavailable.push(`${location}: no 1220.20/5000.25 account found`);
        continue;
      }

      const where = `WHERE TxnDate >= '${from}'`;
      const [bills, purchases] = await Promise.all([
        qbQueryAll<BillDoc>(location as Location, 'Bill', where),
        qbQueryAll<BillDoc>(location as Location, 'Purchase', where),
      ]);

      const dollars = new Map<string, number>();
      const docs = new Map<string, Set<string>>();
      for (const doc of [...bills, ...purchases]) {
        const month = (doc.TxnDate ?? '').slice(0, 7);
        if (month === '') continue;
        for (const line of doc.Line ?? []) {
          const acct = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
          if (acct === undefined || !wanted.has(acct)) continue;
          dollars.set(month, (dollars.get(month) ?? 0) + (line.Amount ?? 0));
          const seen = docs.get(month) ?? new Set<string>();
          seen.add(doc.Id);
          docs.set(month, seen);
        }
      }

      for (const month of months) {
        const observedToDate = Math.round((dollars.get(month) ?? 0) * 100) / 100;
        const observedDocs = docs.get(month)?.size ?? 0;
        rows.push({
          location,
          month,
          observedToDate,
          observedDocs,
          ...computeAccrual({
            location,
            monthEnd: monthEndOf(month),
            asOf,
            observedToDate,
            observedDocs,
          }),
        });
      }
    } catch (error) {
      console.warn(`[lab-supplies-accrual] ${location} skipped:`, error);
      unavailable.push(location);
    }
  }

  return { asOf, months: rows, unavailable };
}

// ---------------------------------------------------------------------------
// THE POOL CONTRIBUTOR (2026-09-14) — replaces the accrual/reversal draft pair.
// Carson: "fold lab supplies into the main journal entry, not a separate piece,
// so it generates on journal entry generation." Lines: lab-supplies-contribution.ts.
// ---------------------------------------------------------------------------

/**
 * Σ of our own POSTED lab-supplies lines for one entity, to date: credits to
 * `2011 Accrued Expenses` less debits. Two populations, both ours:
 *   - close entries (INV CLOSE) carrying lines tagged `src:lab-supplies`
 *   - the retired LAB ACCRUAL pairs, should any ever have posted (none had on
 *     2026-09-14; kept so a posted pair could never be double-counted)
 * Only `status = 'posted'` counts: a draft is not on the books.
 */
export async function fetchPostedLabSuppliesToDate(entity: Entity): Promise<number> {
  const { rows } = await getRdsPool().query<{ net: string | null }>(
    `SELECT sum(CASE WHEN l.posting_type = 'Credit' THEN l.amount ELSE -l.amount END)::text AS net
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.entity = $1
        AND h.status = 'posted'
        AND l.account_name = $2
        AND (
          (h.pay_group = $3 AND $4 = ANY(l.source_row_keys))
          OR h.pay_group = $5
        )`,
    [entity, ACCRUED_EXPENSES_ACCOUNT, INV_CLOSE_PAY_GROUP, LAB_SUPPLIES_SOURCE_KEY, LAB_ACCRUAL_PAY_GROUP],
  );
  return Math.round(Number(rows[0]?.net ?? 0) * 100) / 100;
}

/** Months between two 'YYYY-MM's, inclusive, for sizing the QuickBooks read. */
function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

/**
 * The lab-supplies contribution to one entity's close entry for `month`, plus the
 * basis to retain on the header so the workbook can explain it later.
 *
 * `available` is false only when this entity's QuickBooks realm could not be read
 * — the pool then refuses the whole entry rather than posting one that is quietly
 * missing a piece.
 */
export async function labSuppliesContributionFor(
  entity: Entity,
  month: string,
): Promise<{ contribution: LabSuppliesContribution; snapshot: LabSuppliesPoolSnapshot | null }> {
  const asOf = new Date().toISOString().slice(0, 10);
  const monthEnded = monthEndOf(month) < asOf;
  // Reach back to the earliest month that could still carry an unkeyed estimate
  // (the FL curve's p99 lag is ~8 months) or to the requested month, whichever is older.
  const span = Math.max(monthSpan(month, asOf.slice(0, 7)), 9);
  const [read, postedToDate] = await Promise.all([
    fetchLabSuppliesAccrual(span),
    fetchPostedLabSuppliesToDate(entity),
  ]);
  const available = !read.unavailable.some((u) => u.startsWith(entity));
  const contribution = buildLabSuppliesContribution({
    location: entity,
    month,
    months: read.months,
    postedToDate,
    monthEnded,
    available,
  });
  if (!available || !monthEnded) return { contribution, snapshot: null };

  const snapshot: LabSuppliesPoolSnapshot = {
    kind: 'lab-supplies-pool',
    location: entity,
    month,
    asOf: read.asOf,
    target: contribution.target,
    postedToDate,
    delta: contribution.delta,
    months: contribution.basis.map((m) => ({
      month: m.month,
      observedToDate: m.observedToDate,
      observedDocs: m.observedDocs,
      daysElapsed: m.daysElapsed,
      completeness: m.completeness,
      boundBy: m.boundBy,
      trailingAverage: m.trailingAverage,
      accrual: m.accrual,
      flagged: m.flagged,
      flagReason: m.flagReason,
    })),
  };
  return { contribution, snapshot };
}

