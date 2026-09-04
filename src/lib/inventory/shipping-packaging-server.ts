/**
 * The shipping-packaging accrual read from QuickBooks.
 *
 * WHY THIS IS A LIB AND NOT JUST A ROUTE
 *
 * Same reason as `lab-supplies-server.ts`: whatever displays this number and
 * whatever posts it must be the same number. Reading QuickBooks twice through two
 * code paths is how a screen and an entry drift apart.
 *
 * WHY IT QUERIES QUICKBOOKS DIRECTLY AND NOT THE RDS MIRROR
 *
 * `inventory.qb_documents` has no line-level account column — `line_amounts` is a
 * bare array — so "bills coded to 1220.30" is not expressible against it, and its
 * `synced_at` is a one-shot 2026-08-24 snapshot. Account-level truth only exists on
 * the QuickBooks side, and the whole formula turns on how recent the entry is.
 *
 * FILTERED BY ACCOUNT ID, AND ITEM-BASED LINES ARE RESOLVED TOO
 *
 * Never by vendor name: Amazon Business alone appears under two separate QuickBooks
 * vendor records in Florida, and 1220.30's vendors span Uline under three spellings
 * (`Uline Ship Supplies - AutoPay`, `ULINE`), Mailers HQ, Consolidated Label,
 * Paksouth, Grainger under two records, Associated Paper, Vevor and Walmart.
 *
 * And unlike the lab-supplies read, this resolves ITEM-based lines as well as
 * account-based ones. 1220.30 is an inventory asset account, which a line can reach
 * through an Item's `AssetAccountRef`; reading only `AccountBasedExpenseLineDetail`
 * would silently drop those. (Measured 2026-09-04: no 1220.30 line currently
 * arrives that way in any realm — but "currently" is not a guarantee, and the cost
 * of covering it is one extra query.)
 *
 * Read-only against QuickBooks — SELECT queries only, nothing is written there.
 */
import { qbQueryAll, type Location } from '@/lib/quickbooks-multi';
import {
  computeShippingAccrual,
  monthEndOf,
  shiftMonth,
  trailingAverageWindow,
  SHIPPING_LOCATIONS,
  TRAILING_MONTHS,
  type ShippingAccrualResult,
  type ShippingLocation,
} from './shipping-packaging-accrual';
import { buildShippingContribution } from './shipping-packaging-je';
import type { JeContribution } from './je-pool';

/** The one account this reads. 5000.20 is the OFFSET, not a source of spend —
 *  including it would double-count the accountant's own monthly relief. */
const ASSET_ACCT_NUM = '1220.30';

interface AccountRow {
  Id: string;
  AcctNum?: string;
}

interface ItemRow {
  Id: string;
  AssetAccountRef?: { value?: string };
  ExpenseAccountRef?: { value?: string };
}

interface DocLine {
  Amount?: number;
  AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string } };
  ItemBasedExpenseLineDetail?: { ItemRef?: { value?: string } };
}

interface PurchaseDoc {
  Id: string;
  TxnDate?: string;
  Line?: DocLine[];
}

export interface ShippingAccrualMonth extends ShippingAccrualResult {
  location: ShippingLocation;
  /** 'YYYY-MM' */
  month: string;
  observedToDate: number;
  observedDocs: number;
}

export interface ShippingAccrualResponse {
  asOf: string;
  /** The trailing window each location's average was measured over, oldest first. */
  trailingWindow: string[];
  months: ShippingAccrualMonth[];
  /** Locations whose QuickBooks realm could not be read; their rows are absent. */
  unavailable: string[];
}

/** Monthly 1220.30 dollars and distinct documents for one realm. */
interface MonthlySpend {
  dollars: Map<string, number>;
  docs: Map<string, Set<string>>;
}

/** The trailing `count` months ending with the one containing `asOf`, oldest first. */
export function recentMonths(asOf: string, count: number): string[] {
  const end = asOf.slice(0, 7);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push(shiftMonth(end, i));
  return out;
}

async function pullMonthlySpend(location: Location, from: string): Promise<MonthlySpend | null> {
  const accounts = await qbQueryAll<AccountRow>(location, 'Account', '');
  const wanted = new Set(accounts.filter((a) => a.AcctNum === ASSET_ACCT_NUM).map((a) => a.Id));
  if (wanted.size === 0) return null;

  const items = await qbQueryAll<ItemRow>(location, 'Item', '');
  const itemHits = new Set<string>();
  for (const it of items) {
    const acct = it.AssetAccountRef?.value ?? it.ExpenseAccountRef?.value;
    if (acct !== undefined && wanted.has(acct)) itemHits.add(it.Id);
  }

  const where = `WHERE TxnDate >= '${from}'`;
  const [bills, purchases] = await Promise.all([
    qbQueryAll<PurchaseDoc>(location, 'Bill', where),
    qbQueryAll<PurchaseDoc>(location, 'Purchase', where),
  ]);

  const dollars = new Map<string, number>();
  const docs = new Map<string, Set<string>>();
  for (const doc of [...bills, ...purchases]) {
    const month = (doc.TxnDate ?? '').slice(0, 7);
    if (month === '') continue;
    for (const line of doc.Line ?? []) {
      const direct = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
      const itemRef = line.ItemBasedExpenseLineDetail?.ItemRef?.value;
      const hit =
        (direct !== undefined && wanted.has(direct)) ||
        (itemRef !== undefined && itemHits.has(itemRef));
      if (!hit) continue;
      dollars.set(month, (dollars.get(month) ?? 0) + (line.Amount ?? 0));
      const seen = docs.get(month) ?? new Set<string>();
      seen.add(doc.Id);
      docs.set(month, seen);
    }
  }
  return { dollars, docs };
}

/**
 * The accrual for the trailing `monthCount` months, every location.
 *
 * The QuickBooks pull always reaches back far enough to cover BOTH the requested
 * display months and the trailing-average window, so the baseline and the observed
 * figures come from one read and cannot disagree.
 *
 * One unreachable realm must not blank the other two — it is reported in
 * `unavailable` and its rows are simply absent, which the caller can see.
 */
export async function fetchShippingAccrual(monthCount = 6): Promise<ShippingAccrualResponse> {
  const asOf = new Date().toISOString().slice(0, 10);
  const display = recentMonths(asOf, monthCount);
  const window = trailingAverageWindow(asOf);
  const from = `${display[0] < window[0] ? display[0] : window[0]}-01`;

  const rows: ShippingAccrualMonth[] = [];
  const unavailable: string[] = [];

  for (const location of SHIPPING_LOCATIONS) {
    try {
      const spend = await pullMonthlySpend(location as Location, from);
      if (spend === null) {
        unavailable.push(`${location}: no ${ASSET_ACCT_NUM} account found`);
        continue;
      }

      const windowValues = window.map((m) => Math.round((spend.dollars.get(m) ?? 0) * 100) / 100);
      const activeMonths = windowValues.filter((v) => v !== 0).length;
      const trailingAverage =
        Math.round((windowValues.reduce((a, b) => a + b, 0) / TRAILING_MONTHS) * 100) / 100;

      for (const month of display) {
        const observedToDate = Math.round((spend.dollars.get(month) ?? 0) * 100) / 100;
        const observedDocs = spend.docs.get(month)?.size ?? 0;
        rows.push({
          location,
          month,
          observedToDate,
          observedDocs,
          ...computeShippingAccrual({
            location,
            monthEnd: monthEndOf(month),
            asOf,
            observedToDate,
            observedDocs,
            trailingAverage,
            activeMonths,
          }),
        });
      }
    } catch (error) {
      console.warn(`[shipping-packaging-accrual] ${location} skipped:`, error);
      unavailable.push(location);
    }
  }

  return { asOf, trailingWindow: window, months: rows, unavailable };
}

/**
 * The pooled-JE contribution for one entity-month.
 *
 * Refuses a month that has not ended. Completeness is measured in days AFTER
 * month-end, so a month still running scores 0% and would accrue a FULL month's
 * average against a handful of elapsed days — on 2026-09-04 that is $6,106.07 of
 * Florida September against four days. A tab may show the running month because the
 * trend is worth seeing; an ENTRY from it is not.
 *
 * NOT WIRED IN. `close-server.ts` and the generate route are owned elsewhere; the
 * integration point is written up in the DS, §8.
 */
export async function shippingContributionFor(
  location: ShippingLocation,
  month: string,
): Promise<JeContribution> {
  const asOf = new Date().toISOString().slice(0, 10);
  if (monthEndOf(month) >= asOf) {
    throw new Error(
      `shippingContributionFor: ${month} has not ended yet (as of ${asOf}) — an accrual for a ` +
        'month still in progress would book a full month of cost against a partial month',
    );
  }

  // Reach back far enough to include the requested month whatever it is, so a
  // regeneration of an older month reads the figures a tab would show.
  const [ay, am] = asOf.slice(0, 7).split('-').map(Number);
  const [my, mm] = month.split('-').map(Number);
  const span = (ay - my) * 12 + (am - mm) + 1;
  if (span < 1) throw new Error(`shippingContributionFor: ${month} is in the future`);

  const { months } = await fetchShippingAccrual(Math.max(span, 1));
  const row = months.find((r) => r.location === location && r.month === month) ?? null;
  return buildShippingContribution({ location, month, result: row });
}
