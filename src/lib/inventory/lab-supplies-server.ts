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
import { buildLabAccrualDrafts, LAB_ACCRUAL_PAY_GROUP, ACCRUAL_ENTITY_BY_LOCATION } from './lab-supplies-je';
import type { LabAccrualSnapshot } from './je-detail-accrual';
import { loadDraft } from '@/lib/payroll/store';
import { getRdsPool } from '@/lib/rds';
import { saveDraft, saveSourceSnapshot } from '@/lib/payroll/store';
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

/** One stored half of an accrual pair, for the Inventory Close tab. */
export interface LabAccrualHeader {
  id: number;
  entity: string;
  kind: 'accrual' | 'reversal';
  status: 'draft' | 'needs_review' | 'approved' | 'posted' | 'error';
  qb_doc_number: string | null;
  txn_date: string | null;
  total_debits: number;
  total_credits: number;
  variance: number;
}

export interface LabAccrualLine {
  postingType: 'Debit' | 'Credit';
  amount: number;
  accountName: string;
  memo: string;
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

  // `observedAsOf` is the date the QuickBooks read was actually taken — the one that fixes
  // completeness, and so the one the retained snapshot must carry.
  const { months, unavailable, asOf: observedAsOf } = await fetchLabSuppliesAccrual(Math.max(span, 1));

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
    const accrualId = await saveDraft(pair.accrual, snapshotHash);
    const reversalId = await saveDraft(pair.reversal, snapshotHash);

    // RETAIN THE INPUTS, not just their fingerprint. Completeness is a function of the day
    // the QuickBooks observation was taken, so re-pulling tomorrow returns a smaller accrual
    // than the one that posted — there is no re-reading this source. The entry's `Accrual
    // basis` sheet (both the download and the QuickBooks attachment) is built from this row;
    // without it the workbook ships with its Journal Entry sheet alone. See DS §6.
    const snapshot: LabAccrualSnapshot = {
      location: row.location,
      month: row.month,
      asOf: observedAsOf,
      observedToDate: row.observedToDate,
      observedDocs: row.observedDocs,
      normalDocs: ACCRUAL_PARAMETERS.normalDocsPerMonth[row.location],
      daysElapsed: row.daysElapsed,
      curveCompleteness: row.curveCompleteness,
      entryCompleteness: row.entryCompleteness,
      completeness: row.completeness,
      boundBy: row.boundBy,
      trailingAverage: row.trailingAverage,
      accrual: row.accrual,
      estimatedTotal: row.estimatedTotal,
      flagged: row.flagged,
      flagReason: row.flagReason,
      borrowedCurve: row.borrowedCurve,
    };
    const entity = ACCRUAL_ENTITY_BY_LOCATION[row.location];
    // Best-effort: a failed snapshot write must not lose the drafts that were just saved.
    // It costs the basis sheet, not the entry.
    try {
      await saveSourceSnapshot(accrualId, entity, snapshot);
      await saveSourceSnapshot(reversalId, entity, snapshot);
    } catch (error) {
      console.warn(`[lab-supplies-accrual] snapshot not retained for ${row.location} ${row.month}:`, error);
    }
    saved.push(`${row.location}: ${pair.accrual.docNumber} + ${pair.reversal.docNumber}`);
  }

  return { saved, skipped, unavailable };
}

/**
 * The stored lab-accrual drafts for a month, in the shape the Inventory Close tab
 * already renders its own drafts in.
 *
 * BOTH halves of every pair, deliberately. The reversal is dated the first of the
 * NEXT month and is a separate posting act; hiding it would leave an accrual on the
 * books with nothing on screen saying it comes back off.
 *
 * Matched on `period_end`, not `pay_date` — the pair spans two pay dates by design
 * (see `lab-supplies-je.ts`) and both halves belong to the accrued month.
 */
export async function listLabAccrualDrafts(month: string): Promise<{
  headers: LabAccrualHeader[];
  linesById: Record<string, LabAccrualLine[]>;
}> {
  const { rows } = await getRdsPool().query<{
    id: number;
    entity: string;
    kind: string;
    status: string;
    qb_doc_number: string | null;
    txn_date: string | null;
    total_debits: string;
    total_credits: string;
    variance: string;
  }>(
    `SELECT id, entity, kind, status, qb_doc_number,
            to_char(txn_date, 'YYYY-MM-DD') AS txn_date,
            total_debits::text, total_credits::text, variance::text
     FROM accounting.payroll_journal_headers
     WHERE pay_group = $1 AND period_end = $2
     ORDER BY entity, kind DESC`,
    [LAB_ACCRUAL_PAY_GROUP, monthEndOf(month)],
  );

  const headers: LabAccrualHeader[] = rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    kind: r.kind === 'reversal' ? 'reversal' : 'accrual',
    status: r.status as LabAccrualHeader['status'],
    qb_doc_number: r.qb_doc_number,
    txn_date: r.txn_date,
    total_debits: Number(r.total_debits),
    total_credits: Number(r.total_credits),
    variance: Number(r.variance),
  }));

  const linesById: Record<string, LabAccrualLine[]> = {};
  for (const h of headers) {
    const loaded = await loadDraft(h.id);
    linesById[String(h.id)] = (loaded?.lines ?? []).map((l) => ({
      postingType: l.postingType,
      amount: l.amount,
      accountName: l.accountName,
      memo: l.memo,
    }));
  }
  return { headers, linesById };
}
