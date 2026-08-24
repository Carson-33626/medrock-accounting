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
  CategoryJE,
  CategoryJELine,
  CategoryRollForwardRow,
  CloseBasis,
  InvCloseHeader,
  InvCloseLine,
  LocationJE,
  QbAccountLine,
  RollForwardRow,
} from '@/types/inventory';
import { accountsForCategory, matchBalanceSheetAccount, INVENTORY_ACCOUNT, COGS_ACCOUNT } from './category-accounts';

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

// INVENTORY_ACCOUNT / COGS_ACCOUNT now live in ./category-accounts (that module
// is their natural home, and monthly-close needs to depend on category-accounts
// without a cycle). Re-exported here so existing importers keep working.
export { INVENTORY_ACCOUNT, COGS_ACCOUNT } from './category-accounts';

/** 'MedRock Florida' → 'FL' — mirrors the End of Month tab's SHORT_ENT labels. */
export function shortInventoryLocation(location: string): string {
  const name = location.replace('MedRock ', '');
  if (name === 'Florida') return 'FL';
  if (name === 'Tennessee') return 'TN';
  if (name === 'Texas') return 'TX';
  return name;
}

/** 'FL Inv Adj 2026.07' — the close JE's DocNumber, styled after 'FL % Allo 2026.06'.
 *  One source of truth: the UI preview and the live post both derive from here. */
export function invCloseDocNumber(location: string, month: string): string {
  return `${shortInventoryLocation(location)} Inv Adj ${month.replace('-', '.')}`;
}

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

/** Display labels for the stored-draft workflow states. */
export const CLOSE_STATUS_LABEL: Record<InvCloseHeader['status'], string> = {
  draft: 'Draft',
  needs_review: 'Needs review',
  approved: 'Approved',
  posted: 'Posted',
  error: 'Error',
};

/**
 * The stored draft header for one location, if drafts have been generated.
 * Headers carry QB token naming ('MedRock FL') while rollback rows carry RDS
 * names ('MedRock Florida') — match on the short label.
 */
export function findCloseHeader(location: string, headers: InvCloseHeader[]): InvCloseHeader | null {
  const short = shortInventoryLocation(location);
  return headers.find((h) => shortInventoryLocation(h.entity) === short) ?? null;
}

/**
 * The lines a reader should see for one location — the stored draft's lines
 * when a draft exists (those are frozen at generation and are what will post),
 * the live suggestion otherwise. ONE rule for the close UI tables and the
 * xlsx export; they must never disagree.
 */
export function closeDisplayLines(
  je: LocationJE,
  header: InvCloseHeader | null,
  storedLines: InvCloseLine[],
  basis: CloseBasis,
  monthEnd: string,
): InvCloseLine[] {
  if (header) return storedLines;
  return journalEntryLines(je, basis, monthEnd).map((l) => ({
    postingType: l.debit !== null ? 'Debit' : 'Credit',
    amount: l.debit ?? l.credit ?? 0,
    accountName: l.account,
    memo: l.memo,
  }));
}

/**
 * Provenance note for the export's Journal-Entries sheet: whether each
 * location's rows are a stored draft (with its DocNumber + workflow status,
 * as the UI badges show) or a live suggestion. A posted draft reports the
 * DocNumber QuickBooks actually assigned.
 */
export function closeJeSheetNote(
  journalEntries: LocationJE[],
  headers: InvCloseHeader[],
  month: string,
): string {
  if (headers.length === 0) {
    return 'Journal entries are SUGGESTED ONLY — no drafts generated; nothing is posted to QuickBooks.';
  }
  const parts = journalEntries.map((je) => {
    const short = shortInventoryLocation(je.location);
    const header = findCloseHeader(je.location, headers);
    if (!header) return `${short}: live suggestion (no draft)`;
    const doc =
      header.status === 'posted' ? (header.qb_doc_number ?? '—') : invCloseDocNumber(je.location, month);
    return `${short}: ${doc} — ${CLOSE_STATUS_LABEL[header.status]}`;
  });
  return (
    'Journal entries show the STORED DRAFT where one exists (frozen at generation — what posts), ' +
    `the live suggestion otherwise. ${parts.join(' · ')}.`
  );
}

/** One (location, category) ending value out of the lot-depletion ledger. */
export interface CategoryLedgerValue {
  location: string;
  qbCategory: string;
  endingValue: number;
  /** Distinct receipt_ids contributing — the drill-down key set. */
  receiptIds: string[];
  lotCount: number;
}

const categoryKey = (location: string, qbCategory: string): string => `${location}\u0000${qbCategory}`;

/**
 * Category-grain roll-forward for one month. Unlike the location-grain
 * `buildRollForward`, there is no Purchases column: the lot ledger carries
 * remaining value per lot, not a purchases roll — Beginning and Ending are the
 * defensible pair, and COGS at category grain would need a purchases cut the
 * loader does not emit. Rows sort by descending Ending.
 */
export function buildCategoryRollForward(
  current: CategoryLedgerValue[],
  prior: CategoryLedgerValue[] | null,
): CategoryRollForwardRow[] {
  const windowStart = prior === null;
  const priorByKey = new Map<string, number>();
  for (const p of prior ?? []) priorByKey.set(categoryKey(p.location, p.qbCategory), p.endingValue);

  return [...current]
    .sort((a, b) => b.endingValue - a.endingValue)
    .map((c) => ({
      location: c.location,
      qbCategory: c.qbCategory,
      // A category present now but absent last month began at zero — distinct
      // from the window start, where there is no prior month to speak of at all.
      beginning: windowStart ? null : round2(priorByKey.get(categoryKey(c.location, c.qbCategory)) ?? 0),
      ending: round2(c.endingValue),
      receiptIds: c.receiptIds,
      lotCount: c.lotCount,
    }));
}

/**
 * A location's category-grain entry: each category compared against its own QB
 * sub-account balance.
 *
 * A sub-account with no balance-sheet row is treated as $0 (a real, never-funded
 * account — the whole FIFO value is the adjustment), NOT as unknown. Only a
 * missing balance sheet entirely (`bookAvailable === false`) is unknown, and that
 * nulls every adjustment.
 */
export function buildCategoryJE(
  location: string,
  rows: CategoryRollForwardRow[],
  bsAccounts: ReadonlyArray<{ name: string; value: number }>,
  accountNums: Record<string, string>,
  bookAvailable: boolean,
): CategoryJE {
  const unmappedCategories: string[] = [];

  const lines: CategoryJELine[] = rows
    .filter((r) => r.location === location)
    .map((r) => {
      const accounts = accountsForCategory(r.qbCategory);
      if (!accounts.mapped) unmappedCategories.push(r.qbCategory);

      const fifoTarget = round2(r.ending);
      const qbBookBalance = bookAvailable
        ? round2(matchBalanceSheetAccount(accounts.inventory, accountNums, bsAccounts) ?? 0)
        : null;
      const adjustment = qbBookBalance === null ? null : round2(fifoTarget - qbBookBalance);
      const direction: CategoryJELine['direction'] =
        adjustment === null ? null : adjustment > 0 ? 'debit-inventory' : adjustment < 0 ? 'credit-inventory' : 'none';

      return {
        qbCategory: r.qbCategory,
        inventoryAccount: accounts.inventory,
        cogsAccount: accounts.cogs,
        mapped: accounts.mapped,
        fifoTarget,
        qbBookBalance,
        adjustment,
        direction,
        receiptIds: r.receiptIds,
        lotCount: r.lotCount,
      };
    });

  return {
    location,
    lines,
    fifoTarget: round2(lines.reduce((s, l) => s + l.fifoTarget, 0)),
    adjustment: round2(lines.reduce((s, l) => s + (l.adjustment ?? 0), 0)),
    bookAvailable,
    unmappedCategories,
  };
}

/** A category's JE line plus the receipts that produced it — the drill-down key set. */
export interface CategoryJeLine extends JeLine {
  qbCategory: string;
  receiptIds: string[];
}

/**
 * As `categoryJournalEntryLines`, but each line carries the receipt ids of the
 * category that produced it. Two categories can legitimately share one account
 * (Uncoded and Opening Balance both fall back to the parent accounts), so the
 * source ids can only be attached while the emitting category is still in hand —
 * a later lookup keyed by account name collapses them.
 */
export function categoryJournalEntryLinesWithSources(je: CategoryJE, monthEnd: string): CategoryJeLine[] {
  if (!je.bookAvailable) return [];
  const out: CategoryJeLine[] = [];

  for (const line of je.lines) {
    if (line.adjustment === null || line.adjustment === 0) continue;
    const amount = round2(Math.abs(line.adjustment));
    const residual = line.mapped ? '' : ' — residual, needs drug coding';
    const memo = `Adjust ${line.qbCategory} inventory to FIFO (lot-level) as of ${monthEnd}${residual}`;
    const qbCategory = line.qbCategory;
    const receiptIds = line.receiptIds;

    if (line.adjustment > 0) {
      // Inventory understated on the books → increase Inventory, relieve COGS.
      out.push({ account: line.inventoryAccount, debit: amount, credit: null, memo, qbCategory, receiptIds });
      out.push({ account: line.cogsAccount, debit: null, credit: amount, memo, qbCategory, receiptIds });
    } else {
      // Inventory overstated on the books → reduce Inventory, charge COGS.
      out.push({ account: line.cogsAccount, debit: amount, credit: null, memo, qbCategory, receiptIds });
      out.push({ account: line.inventoryAccount, debit: null, credit: amount, memo, qbCategory, receiptIds });
    }
  }
  return out;
}

/**
 * The balanced Dr/Cr pairs for a location's categorized entry — one pair per
 * category with a nonzero adjustment, each on that category's own sub-accounts.
 * Returns [] when the book balance is unavailable (nothing to compare against).
 */
export function categoryJournalEntryLines(je: CategoryJE, monthEnd: string): JeLine[] {
  return categoryJournalEntryLinesWithSources(je, monthEnd).map(({ account, debit, credit, memo }) => ({
    account,
    debit,
    credit,
    memo,
  }));
}
