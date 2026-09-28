/**
 * The revenue each location actually EARNED in a month — the basis for the month-end split.
 *
 * Barbara, 2026-09-28: May was splitting FL 49.57% / TN 48.45% / TX 1.97% instead of
 * FL 43.81% / TN 49.67% / TX 6.53%. The raw P&L income is the wrong basis. Pre-7/16 portal
 * misrouting landed other locations' revenue on FL/TN deposits. Those deposit lines are
 * class-tagged `Allocate - TX|TN|FL` (the 2026-08-19 class-split), and the month-end
 * `% Allo` entry is what moves that revenue to its owner. So each company's P&L income
 * means something different depending on whether that month's allocation has posted:
 *   - not posted (June+): P&L still holds the foreign revenue, and the split over-weights FL.
 *   - posted (April, May): P&L already reflects the move.
 * Both states reduce to the same number. Take P&L income, remove what posted `% Allo` family
 * entries did to income accounts, then apply the classed deposit moves:
 *   income[e] = P&L[e] − allocationIncome[e] − Σ moved out of e + Σ moved into e
 * Verified 2026-05: FL 912,982.39 + 120,239.23 − 129,216.21 + 8,976.98 = 912,982.39, and the
 * raw pre-move figures reproduce Barbara's wrong 49.57 / 48.45 / 1.97 to the penny.
 *
 * Only `% Allo YYYY.MM` family entries dated in the month are removed (eom-manual's
 * isEomAllocationDoc, covering both app-posted and hand-keyed ones). March's revenue moved
 * via the `TrueUp 2026.03` JE instead, which is not removed. March is posted and outside the
 * difference check (check-from 2026-04), so no March basis is recomputed.
 */
import { qbQueryAll, getMonthlyProfitAndLoss } from '../quickbooks-multi';
import { monthEndIso, type Month } from './month';
import { EOM_ENTITIES, type EomEntity, type RevenueTest } from './revenue-rule';
import { classifyAllocateFlag, type RawDeposit, type RawJournalEntry } from './qb-pool';
import { isEomAllocationDoc } from './eom-manual';

/** Revenue that sits in `from`'s books but belongs to `to` (positive = `to` earned it). */
export interface RevenueMove {
  from: EomEntity;
  to: EomEntity;
  amount: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Pure: the earned-revenue basis from its three inputs (see file header). */
export function revenueBasis(
  plIncome: Record<EomEntity, number>,
  allocationIncome: Record<EomEntity, number>,
  moves: readonly RevenueMove[],
): Record<EomEntity, number> {
  const out = {} as Record<EomEntity, number>;
  for (const e of EOM_ENTITIES) out[e] = plIncome[e] - allocationIncome[e];
  for (const mv of moves) {
    out[mv.from] -= mv.amount;
    out[mv.to] += mv.amount;
  }
  for (const e of EOM_ENTITIES) out[e] = round2(out[e]);
  return out;
}

/** Pure: net credit to income accounts carried by the month's `% Allo` family entries. */
export function allocationIncomeNet(
  entries: readonly RawJournalEntry[], incomeAccountIds: ReadonlySet<string>, m: Month,
): number {
  const first = `${m.year}-${String(m.month).padStart(2, '0')}-01`;
  const last = monthEndIso(m);
  let net = 0;
  for (const je of entries) {
    if (!isEomAllocationDoc(je.DocNumber, m)) continue;
    if (je.TxnDate === undefined || je.TxnDate < first || je.TxnDate > last) continue;
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      const id = d?.AccountRef?.value;
      if (id === undefined || !incomeAccountIds.has(id)) continue;
      net += (d?.PostingType === 'Credit' ? 1 : -1) * (l.Amount ?? 0);
    }
  }
  return round2(net);
}

/** Pure: classed passthrough revenue on one company's deposits (income accounts only). */
export function depositRevenueMoves(
  deposits: readonly RawDeposit[], holder: EomEntity, incomeAccountIds: ReadonlySet<string>,
): RevenueMove[] {
  const out: RevenueMove[] = [];
  for (const dep of deposits) {
    for (const l of dep.Line ?? []) {
      const d = l.DepositLineDetail;
      const id = d?.AccountRef?.value;
      if (id === undefined || !incomeAccountIds.has(id)) continue;
      const cls = classifyAllocateFlag(d?.ClassRef?.name ?? null, null, holder);
      if (cls?.rule !== 'passthrough' || cls.counterparty === null || cls.counterparty === 'FOCAS') continue;
      out.push({ from: holder, to: cls.counterparty, amount: l.Amount ?? 0 });
    }
  }
  return out;
}

interface QbAccount { Id: string }

/** Live earned-revenue test for one month. Throws if any company cannot be read — a partial
 *  basis would silently mis-split. `plIncome` and `allocationIncome` ride along so the
 *  End of Month tab can show how the basis was reached. */
export async function fetchRevenueBasis(m: Month): Promise<RevenueTest> {
  const month = `${m.year}-${String(m.month).padStart(2, '0')}`;
  const startDate = `${month}-01`;
  const endDate = monthEndIso(m);
  const where = `WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`;
  const plIncome = {} as Record<EomEntity, number>;
  const allocationIncome = {} as Record<EomEntity, number>;
  const moves: RevenueMove[] = [];
  for (const e of EOM_ENTITIES) {
    const rows = await getMonthlyProfitAndLoss({ location: e, startDate, endDate, accounting_method: 'Accrual' });
    const row = rows.find((r) => r.month === month);
    if (!row) throw new Error(`no P&L data for ${e} ${month}`);
    plIncome[e] = row.revenue;
    const accounts = await qbQueryAll<QbAccount>(e, 'Account', `WHERE Classification = 'Revenue'`);
    const incomeIds = new Set(accounts.map((a) => a.Id));
    const jes = await qbQueryAll<RawJournalEntry>(e, 'JournalEntry', where);
    allocationIncome[e] = allocationIncomeNet(jes, incomeIds, m);
    const deposits = await qbQueryAll<RawDeposit>(e, 'Deposit', where);
    moves.push(...depositRevenueMoves(deposits, e, incomeIds));
  }
  return { month, income: revenueBasis(plIncome, allocationIncome, moves), plIncome, allocationIncome };
}
