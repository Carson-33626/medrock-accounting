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
import { computeAccrual, type AccrualLocation, type AccrualResult } from './lab-supplies-accrual';
import { buildLabAccrualDrafts } from './lab-supplies-je';
import { saveDraft } from '@/lib/payroll/store';
import { createHash } from 'node:crypto';

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
// DRAFT GENERATION
// ---------------------------------------------------------------------------

/**
 * Generate (or regenerate) the lab-supplies accrual drafts for one month.
 *
 * Writes to OUR draft table only — nothing reaches QuickBooks until someone
 * approves and posts, exactly like the FIFO close. `saveDraft` refuses to
 * overwrite a header that has already posted, so regenerating is safe.
 *
 * The month is normally the one just closed. Every location that has something
 * to accrue produces a PAIR: the accrual at month-end and its reversal on the
 * first of the next month. A location whose accrual has fallen to zero produces
 * nothing — the month has settled and the real bills are carrying the cost.
 */
export async function generateLabAccrualDrafts(
  month: string,
): Promise<{ saved: string[]; skipped: string[]; unavailable: string[] }> {
  // Reach back far enough to include the requested month whatever it is, so a
  // regeneration of an older month reads the same figures the tab shows.
  const asOf = new Date().toISOString().slice(0, 10);
  const [ay, am] = asOf.slice(0, 7).split('-').map(Number);
  const [my, mm] = month.split('-').map(Number);
  const span = (ay - my) * 12 + (am - mm) + 1;
  if (span < 1) throw new Error(`generateLabAccrualDrafts: ${month} is in the future`);

  // AN UNFINISHED MONTH CANNOT BE ACCRUED. The completeness curve is measured in
  // days AFTER month-end, so a month still running scores 0% and would accrue a
  // FULL month's average — on 2026-09-03 that is $3,024.06 of Florida September
  // against three elapsed days. The tab shows the current month because the trend
  // is worth seeing; generating an entry from it is not. Accruals are a month-end
  // act, so the month must have ended.
  if (monthEndOf(month) >= asOf) {
    throw new Error(
      `generateLabAccrualDrafts: ${month} has not ended yet (as of ${asOf}) — ` +
        'an accrual for a month still in progress would book a full month of cost against a partial month',
    );
  }

  const { months, unavailable } = await fetchLabSuppliesAccrual(Math.max(span, 1));

  const saved: string[] = [];
  const skipped: string[] = [];

  for (const row of months) {
    if (row.month !== month) continue;
    const pair = buildLabAccrualDrafts({
      location: row.location,
      month: row.month,
      accrual: row.accrual,
      completeness: row.completeness,
      boundBy: row.boundBy,
    });
    if (pair === null) {
      skipped.push(`${row.location}: nothing to accrue (month has settled)`);
      continue;
    }
    // Hash the INPUTS, not the built lines: the drift gate should fire when the
    // estimate moves, not when the memo wording changes.
    const snapshotHash = createHash('sha256')
      .update(
        JSON.stringify({
          location: row.location,
          month: row.month,
          accrual: row.accrual,
          completeness: row.completeness,
          observedToDate: row.observedToDate,
          observedDocs: row.observedDocs,
        }),
      )
      .digest('hex');
    await saveDraft(pair.accrual, snapshotHash);
    await saveDraft(pair.reversal, snapshotHash);
    saved.push(`${row.location}: ${pair.accrual.docNumber} + ${pair.reversal.docNumber}`);
  }

  return { saved, skipped, unavailable };
}
