/**
 * Pure roll-forward and suggested-JE derivation for the monthly close, built on
 * the rollback dual-basis valuation. No I/O — the route feeds it rollback rows
 * (this month + prior month) and QB book balances; these functions turn that
 * into the roll-forward table and per-location journal entries.
 *
 * Roll-forward, per location + company total (accrual, no per-category cut):
 *   Beginning  = prior month's value (same basis)
 * + Purchases  = the month's purchases column (same basis)
 * − Ending     = the month's value
 * = COGS       = Beginning + Purchases − Ending   (ALWAYS derived)
 * The earliest month has no prior row → Beginning/COGS are null ("window start").
 */
import type {
  CloseBasis,
  LocationJE,
  QbAccountLine,
  RollForwardRow,
} from '@/types/inventory';

/** Minimal per-(month, location) value shape the roll-forward needs. */
export interface RollbackMonthValue {
  location: string;
  valueFloor: number | null;
  valueFull: number | null;
  purchasesFloor: number | null;
  purchasesFull: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function pickValue(row: RollbackMonthValue, basis: CloseBasis): number {
  const v = basis === 'floor' ? row.valueFloor : row.valueFull;
  return v ?? 0;
}

function pickPurchases(row: RollbackMonthValue, basis: CloseBasis): number | null {
  return basis === 'floor' ? row.purchasesFloor : row.purchasesFull;
}

/**
 * Build the roll-forward rows for one month.
 *
 * @param currentRows  rollback rows for the selected month (one per location).
 * @param priorRows    rollback rows for the immediately-prior month, or null
 *                     when the selected month is the earliest in the table.
 * @param basis        'floor' | 'full' — selects value/purchases columns.
 * @param purchasesAvailable  whether the loader's purchases columns exist in RDS.
 *                     When false every Purchases/COGS is null (pending notice).
 * Returns per-location rows sorted by descending Ending, followed by a Total row.
 */
export function buildRollForward(
  currentRows: RollbackMonthValue[],
  priorRows: RollbackMonthValue[] | null,
  basis: CloseBasis,
  purchasesAvailable: boolean,
): RollForwardRow[] {
  const windowStart = priorRows === null;
  const priorByLocation = new Map<string, RollbackMonthValue>();
  for (const r of priorRows ?? []) priorByLocation.set(r.location, r);

  const locationRows: RollForwardRow[] = [...currentRows]
    .sort((a, b) => pickValue(b, basis) - pickValue(a, basis))
    .map((r) => {
      const ending = round2(pickValue(r, basis));

      // A location present this month but absent last month began at zero.
      const beginning = windowStart
        ? null
        : round2(pickValue(priorByLocation.get(r.location) ?? emptyValue(r.location), basis));

      const rawPurchases = purchasesAvailable ? pickPurchases(r, basis) : null;
      const purchases = rawPurchases === null ? null : round2(rawPurchases);
      const purchasesPending = purchases === null;

      const cogs =
        beginning !== null && purchases !== null ? round2(beginning + purchases - ending) : null;

      return {
        cut: 'location' as const,
        label: r.location,
        beginning,
        purchases,
        cogs,
        ending,
        windowStart,
        purchasesPending,
      };
    });

  const totalRow = buildTotalRow(locationRows, windowStart);
  return [...locationRows, totalRow];
}

function emptyValue(location: string): RollbackMonthValue {
  return { location, valueFloor: 0, valueFull: 0, purchasesFloor: 0, purchasesFull: 0 };
}

function buildTotalRow(locationRows: RollForwardRow[], windowStart: boolean): RollForwardRow {
  const ending = round2(locationRows.reduce((s, r) => s + r.ending, 0));

  const beginning = windowStart
    ? null
    : round2(locationRows.reduce((s, r) => s + (r.beginning ?? 0), 0));

  // The total is only meaningful if every location has purchases; otherwise it
  // cannot tie, so it degrades to pending like the rows it aggregates.
  const anyPurchasesPending = locationRows.some((r) => r.purchasesPending);
  const purchases = anyPurchasesPending
    ? null
    : round2(locationRows.reduce((s, r) => s + (r.purchases ?? 0), 0));
  const purchasesPending = purchases === null;

  const cogs =
    beginning !== null && purchases !== null ? round2(beginning + purchases - ending) : null;

  return {
    cut: 'total',
    label: 'Total',
    beginning,
    purchases,
    cogs,
    ending,
    windowStart,
    purchasesPending,
  };
}

/**
 * Assemble the suggested-JE inputs for one location. `fifoTarget` is the
 * selected-basis Ending; `qbBookBalance`/`qbAccounts` come from the QB balance
 * sheet (null when the realm is disconnected or the section is missing).
 */
export function buildLocationJE(
  location: string,
  fifoTarget: number,
  qbBookBalance: number | null,
  qbAccounts: QbAccountLine[],
): LocationJE {
  const bookAvailable = qbBookBalance !== null;
  const adjustment = bookAvailable ? round2(fifoTarget - qbBookBalance) : null;
  const direction: LocationJE['direction'] =
    adjustment === null ? null : adjustment > 0 ? 'debit-inventory' : adjustment < 0 ? 'credit-inventory' : 'none';

  return {
    location,
    fifoTarget: round2(fifoTarget),
    qbBookBalance: qbBookBalance === null ? null : round2(qbBookBalance),
    qbAccounts,
    bookAvailable,
    adjustment,
    direction,
  };
}

export const INVENTORY_ACCOUNT = '1220 Inventory Asset';
export const COGS_ACCOUNT = 'Cost of Goods Sold';

/** One copy-ready journal line (debit XOR credit). */
export interface JeLine {
  account: string;
  debit: number | null;
  credit: number | null;
  memo: string;
}

/**
 * The two balanced lines the suggested entry would post for one location.
 * Returns [] when the book balance is unavailable or the adjustment is zero
 * (nothing to book). ADJ > 0 → Dr Inventory / Cr COGS; ADJ < 0 → the reverse.
 */
export function journalEntryLines(je: LocationJE, basis: CloseBasis, monthEnd: string): JeLine[] {
  if (je.adjustment === null || je.adjustment === 0) return [];
  const amount = round2(Math.abs(je.adjustment));
  const memo = `Adjust inventory to FIFO (rollback, ${basis}) as of ${monthEnd}`;

  if (je.adjustment > 0) {
    // Inventory understated on the books → increase Inventory, relieve COGS.
    return [
      { account: INVENTORY_ACCOUNT, debit: amount, credit: null, memo },
      { account: COGS_ACCOUNT, debit: null, credit: amount, memo },
    ];
  }
  // Inventory overstated on the books → reduce Inventory, charge COGS.
  return [
    { account: COGS_ACCOUNT, debit: amount, credit: null, memo },
    { account: INVENTORY_ACCOUNT, debit: null, credit: amount, memo },
  ];
}
