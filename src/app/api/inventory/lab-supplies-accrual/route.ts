import { NextResponse } from 'next/server';
import { qbQueryAll, type Location } from '@/lib/quickbooks-multi';
import {
  computeAccrual,
  type AccrualLocation,
  type AccrualResult,
} from '@/lib/inventory/lab-supplies-accrual';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The lab-supplies accrual, computed live against QuickBooks.
 *
 * Lab supplies were cleared out of FIFO entirely (Carson, 2026-09-03) because they
 * are bought ad hoc and never received into LifeFile — the ledger has no basis to
 * deplete. This replaces that missing depletion with a simulated monthly cost,
 * sized from what QuickBooks has actually recorded so far.
 *
 * WHY IT QUERIES QUICKBOOKS DIRECTLY AND NOT THE RDS MIRROR
 *
 * `inventory.qb_documents` has no line-level account column — `line_amounts` is a
 * bare array — so "bills coded to 1220.20" is not expressible against it, and its
 * `synced_at` is a one-shot 2026-08-24 snapshot. Account-level truth only exists on
 * the QuickBooks side, and the whole formula turns on how RECENT the entry is.
 *
 * Filtered by ACCOUNT ID, never vendor name: Amazon Business alone appears under
 * two separate QuickBooks vendor records in Florida, so a name filter silently
 * loses half of it.
 *
 * Read-only — SELECT queries only, nothing is written to QuickBooks.
 */

const ACCOUNT_NUMS = ['1220.20', '5000.25'] as const;

const LOCATIONS: readonly AccrualLocation[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];

interface AccountRow {
  Id: string;
  AcctNum?: string;
  Name?: string;
  FullyQualifiedName?: string;
}

interface LineDetail {
  AccountRef?: { value?: string; name?: string };
}

interface DocLine {
  Amount?: number;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: LineDetail;
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
function monthEndOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The trailing `count` months ending with the one containing `asOf`. */
function recentMonths(asOf: string, count: number): string[] {
  const [y, m] = asOf.split('-').map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export async function GET() {
  const asOf = new Date().toISOString().slice(0, 10);
  const months = recentMonths(asOf, 6);
  const from = `${months[0]}-01`;

  const rows: LabSuppliesAccrualMonth[] = [];
  const unavailable: string[] = [];

  for (const location of LOCATIONS) {
    try {
      // Resolve the two account ids for THIS realm — ids differ per company.
      const accounts = await qbQueryAll<AccountRow>(location as Location, 'Account', '');
      const wanted = new Set(
        accounts.filter((a) => a.AcctNum && ACCOUNT_NUMS.includes(a.AcctNum as '1220.20')).map((a) => a.Id),
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
      // One realm being unreachable must not blank the other two.
      console.warn(`[inventory/lab-supplies-accrual] ${location} skipped:`, error);
      unavailable.push(location);
    }
  }

  const body: LabSuppliesAccrualResponse = { asOf, months: rows, unavailable };
  return NextResponse.json(body);
}
