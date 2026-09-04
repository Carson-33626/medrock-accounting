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
  CategoryComparisonRow,
  CategoryRollForwardRow,
  CloseBasis,
  InvCloseHeader,
  InvCloseLine,
  LocationJE,
  QbAccountLine,
  RollForwardRow,
} from '@/types/inventory';
import {
  accountsForCategory,
  matchBalanceSheetAccount,
  CATEGORY_ACCOUNT_MAP,
  INVENTORY_ACCOUNT,
  COGS_ACCOUNT,
  WASTE_ACCOUNT,
} from './category-accounts';

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

/**
 * Total a column of currency the way a reader does: round each figure to cents,
 * then add. Summing raw floats first and rounding once can land a cent away from
 * the visible rows, and the order of the addends changes which way.
 *
 * That is not academic here. The point-in-time page and this close state the same
 * month from the same lot values in different orders: Tennessee 2026-03 rendered
 * $2,795,295.20 on one screen against $2,795,295.19 on the other. On two views
 * whose whole claim is that they agree, a one-cent gap reads as a broken
 * reconciliation. Use this for any total shown beneath the rows it totals.
 *
 * Display only — it must not be used to compute what posts to QuickBooks.
 */
export function sumCents(values: number[]): number {
  return values.reduce((cents, v) => cents + Math.round(v * 100), 0) / 100;
}

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

/**
 * The waste/shrink write-down lines for one inventory account, once the loader's
 * `waste_value_in_month` / `shrink_value_in_month` columns exist (DS sec 21.2 —
 * queued behind the adjustment-feed build). Grain-agnostic: the caller passes
 * whichever inventory account matches the columns' grain (per-category
 * sub-account or the parent) when the wiring lands.
 *
 * Shape per the sec 17.4 / 23.1 rulings: BOTH amounts hit the dedicated
 * WASTE_ACCOUNT (never a usage-COGS account), as two debit lines with distinct
 * memos — one JE account, two evidence trails (documented disposal vs count
 * residual) — against a single combined credit to inventory. Amounts are the
 * transform's already-clamped columns: shrink is never negative here (a negative
 * plug routes to counter-direction instrumentation upstream, sec 23.1), so a
 * negative input is a data defect and throws rather than silently netting.
 */
export function wasteShrinkPostingLines(
  inventoryAccount: string,
  wasteValue: number,
  shrinkValue: number,
  monthEnd: string,
): JeLine[] {
  if (wasteValue < 0 || shrinkValue < 0) {
    throw new Error(
      `waste/shrink must be non-negative (clamped upstream): waste=${wasteValue} shrink=${shrinkValue}`,
    );
  }
  const waste = round2(wasteValue);
  const shrink = round2(shrinkValue);
  const total = round2(waste + shrink);
  if (total === 0) return [];

  const lines: JeLine[] = [];
  if (waste > 0) {
    lines.push({
      account: WASTE_ACCOUNT,
      debit: waste,
      credit: null,
      memo: `Documented drug disposal (lot adjustments) for month ending ${monthEnd}`,
    });
  }
  if (shrink > 0) {
    lines.push({
      account: WASTE_ACCOUNT,
      debit: shrink,
      credit: null,
      memo: `Inventory shrink — count residual for month ending ${monthEnd}`,
    });
  }
  lines.push({
    account: inventoryAccount,
    debit: null,
    credit: total,
    memo: `Waste & shrink write-down for month ending ${monthEnd}`,
  });
  return lines;
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
  /** Lots received IN this month, at cost. */
  purchasesValue: number;
  /** qty_consumed x unit_cost for the month. $0 for opening-balance lots (no unit cost). */
  consumedValue: number;
  /** Distinct receipt_ids contributing — the drill-down key set. */
  receiptIds: string[];
  lotCount: number;
}

/** Composite (location, category) map key. Exported so every consumer builds it
 *  identically — a hand-rolled second copy is how a join silently starts missing.
 *  The separator is a NUL escape, which no category name can contain. */
export const categoryKey = (location: string, qbCategory: string): string => `${location}\u0000${qbCategory}`;

/**
 * Category-grain roll-forward for one month: Beginning + Purchases - COGS = Ending.
 *
 * This DID once stop at Beginning and Ending, on the grounds that COGS at category
 * grain needed a purchases cut the loader does not emit. That was wrong, and the
 * accountants need the movement (Carson, 2026-09-03: "the exact COGS that moved
 * from start to end broken down by category detail"). Purchases come from the
 * receipt dates of the very lots behind Ending, and COGS from the ledger's own
 * per-month `qty_consumed` — see `ledger-values.ts`.
 *
 * COGS IS TAKEN AS THE PLUG (`beginning + purchases - ending`), deliberately.
 * Measured across 2026-03, -06 and -07: the plug equals the unit-cost derivation to
 * the cent on 12 of 13 (location, category) cells. The one that differs every month
 * is Florida's `Opening Balance` bucket — OB lots have no `unit_cost`, so the
 * unit-cost term reads $0 while their remaining value genuinely declines ($220.38,
 * $125.78, $176.25 in those months). Using the plug keeps the roll-forward footing
 * by construction, which is the entire point of showing one; `consumedValue` is
 * carried alongside so the two can be compared rather than silently reconciled.
 *
 * Rows sort by descending Ending.
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
      purchases: round2(c.purchasesValue),
      // Null at the window start: with no Beginning there is nothing to plug against,
      // and a COGS figure invented from a missing opening is worse than a blank.
      cogs: windowStart
        ? null
        : round2(
            (priorByKey.get(categoryKey(c.location, c.qbCategory)) ?? 0) +
              c.purchasesValue -
              c.endingValue,
          ),
      /** The loader-consistent figure, for comparison — see the note above. */
      consumed: round2(c.consumedValue),
      ending: round2(c.endingValue),
      receiptIds: c.receiptIds,
      lotCount: c.lotCount,
    }));
}

const directionOf = (adjustment: number | null): CategoryComparisonRow['direction'] =>
  adjustment === null ? null : adjustment > 0 ? 'debit-inventory' : adjustment < 0 ? 'credit-inventory' : 'none';

/**
 * A location's category-grain entry: each category compared against its own QB
 * sub-account balance.
 *
 * A sub-account with no balance-sheet row is treated as $0 (a real, never-funded
 * account — the whole FIFO value is the adjustment), NOT as unknown. Only a
 * missing balance sheet entirely (`bookAvailable === false`) is unknown, and that
 * nulls every adjustment.
 *
 * THE PARENT BALANCE IS READ ONCE. Every unmapped category ('Uncoded',
 * 'Opening Balance', anything new) falls back to the SAME parent accounts, so
 * asking `matchBalanceSheetAccount` for the parent balance per category makes
 * each of them subtract the whole balance B — `Σfifo − 2B` where the truth is
 * `Σfifo − B`. That is inert only while the parent has no balance-sheet row of
 * its own; this close's own residual posting is what gives it one. So the parent
 * balance is captured once as `residualBookBalance`, claimed for display by the
 * first (largest) residual row with the rest reading $0, and compared against the
 * summed residual FIFO exactly once when the JE is emitted.
 */
export function buildCategoryJE(
  location: string,
  rows: CategoryRollForwardRow[],
  bsAccounts: ReadonlyArray<{ name: string; value: number }>,
  accountNums: Record<string, string>,
  bookAvailable: boolean,
): CategoryJE {
  const unmappedCategories: string[] = [];
  const residualBookBalance = bookAvailable
    ? round2(matchBalanceSheetAccount(INVENTORY_ACCOUNT, accountNums, bsAccounts) ?? 0)
    : null;
  let residualBalanceClaimed = false;

  const lines: CategoryComparisonRow[] = rows
    .filter((r) => r.location === location)
    .map((r) => {
      const accounts = accountsForCategory(r.qbCategory);
      const fifoTarget = round2(r.ending);
      // Only a bucket that actually CARRIES value is worth warning about. Florida
      // 2026-03 held 'Uncoded' at $0.00 alongside a real 'Opening Balance', and
      // naming both sent the accountant after the empty one — the coding work had
      // already cleared it. A category at zero contributes nothing to the residual
      // pair and is not a task.
      if (!accounts.mapped && fifoTarget !== 0) unmappedCategories.push(r.qbCategory);
      let qbBookBalance: number | null;
      if (!bookAvailable) {
        qbBookBalance = null;
      } else if (accounts.mapped) {
        qbBookBalance = round2(matchBalanceSheetAccount(accounts.inventory, accountNums, bsAccounts) ?? 0);
      } else {
        // Residual: the parent balance belongs to the aggregate, so exactly one
        // row carries it and the rest read $0 — the rows then foot to the single
        // pair that posts instead of double-subtracting.
        qbBookBalance = residualBalanceClaimed ? 0 : (residualBookBalance ?? 0);
        residualBalanceClaimed = true;
      }
      const adjustment = qbBookBalance === null ? null : round2(fifoTarget - qbBookBalance);

      return {
        qbCategory: r.qbCategory,
        inventoryAccount: accounts.inventory,
        cogsAccount: accounts.cogs,
        mapped: accounts.mapped,
        fifoTarget,
        qbBookBalance,
        adjustment,
        direction: directionOf(adjustment),
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
    residualBookBalance,
  };
}

/** One POSTING line plus the receipts behind it — the drill-down key set.
 *  Distinct from `CategoryComparisonRow` (the FIFO-vs-book table grain): the
 *  residual categories share a single posting pair. */
export interface CategoryPostingLine extends JeLine {
  /** The category this line posts for; the aggregated residual pair carries the
   *  combined label ('Opening Balance + Uncoded'). */
  qbCategory: string;
  /** false on the aggregated residual pair (parent accounts, needs drug coding). */
  mapped: boolean;
  receiptIds: string[];
}

/** Dr/Cr pair for one adjustment. Positive → Dr Inventory / Cr COGS (inventory
 *  understated on the books); negative → the reverse. */
function drCrPair(
  adjustment: number,
  inventoryAccount: string,
  cogsAccount: string,
  memo: string,
  qbCategory: string,
  mapped: boolean,
  receiptIds: string[],
): CategoryPostingLine[] {
  const amount = round2(Math.abs(adjustment));
  const inv = { account: inventoryAccount, memo, qbCategory, mapped, receiptIds };
  const cogs = { account: cogsAccount, memo, qbCategory, mapped, receiptIds };
  return adjustment > 0
    ? [
        { ...inv, debit: amount, credit: null },
        { ...cogs, debit: null, credit: amount },
      ]
    : [
        { ...cogs, debit: amount, credit: null },
        { ...inv, debit: null, credit: amount },
      ];
}

/**
 * As `categoryJournalEntryLines`, but each line carries the receipt ids of the
 * category (or categories) that produced it — a later lookup keyed by account
 * name cannot recover them.
 *
 * Mapped categories get one pair each, on their own sub-accounts.
 *
 * EVERY UNMAPPED CATEGORY GETS ONE SHARED PAIR. They all fall back to the same
 * parent accounts, and the parent's book balance can only be subtracted once —
 * emitting a pair per residual category would net `Σfifo − n·B` against a book
 * balance of B (see `buildCategoryJE`). The aggregate sums their FIFO targets,
 * compares that against `je.residualBookBalance` exactly once, and unions their
 * receipt ids so the evidence trail is complete. Skipped entirely when the
 * combined adjustment is zero.
 */
export function categoryJournalEntryLinesWithSources(je: CategoryJE, monthEnd: string): CategoryPostingLine[] {
  if (!je.bookAvailable) return [];
  const out: CategoryPostingLine[] = [];

  for (const line of je.lines) {
    if (!line.mapped) continue;
    if (line.adjustment === null || line.adjustment === 0) continue;
    const memo = `Adjust ${line.qbCategory} inventory to FIFO (lot-level) as of ${monthEnd}`;
    out.push(
      ...drCrPair(
        line.adjustment,
        line.inventoryAccount,
        line.cogsAccount,
        memo,
        line.qbCategory,
        true,
        line.receiptIds,
      ),
    );
  }

  const residualRows = je.lines.filter((l) => !l.mapped);
  if (residualRows.length > 0) {
    const fifoTarget = round2(residualRows.reduce((s, l) => s + l.fifoTarget, 0));
    const adjustment = round2(fifoTarget - (je.residualBookBalance ?? 0));
    if (adjustment !== 0) {
      // Name the categories the pair actually covers, so the memo stays accurate
      // whatever the mix — sorted for a stable, diffable string.
      const covered = [...new Set(residualRows.map((l) => l.qbCategory))].sort();
      const qbCategory = covered.join(' + ');
      const memo =
        `Adjust ${qbCategory} inventory to FIFO (lot-level) as of ${monthEnd}` +
        ' — residual, needs drug coding';
      const receiptIds = [...new Set(residualRows.flatMap((l) => l.receiptIds))];
      out.push(
        ...drCrPair(adjustment, INVENTORY_ACCOUNT, COGS_ACCOUNT, memo, qbCategory, false, receiptIds),
      );
    }
  }

  return out;
}

/**
 * The balanced Dr/Cr pairs for a location's categorized entry — one pair per
 * mapped category with a nonzero adjustment on its own sub-accounts, plus at
 * most one aggregated residual pair on the parent accounts.
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

// ---------------------------------------------------------------------------
// OPENING CORRECTION (2026-08-26) — the one-time cutover JE. Pure derivations;
// the server orchestration lives in close-server.ts. See
// docs/fifo-monthly-close/2026-08-26-correction-je-proposal.md.
// ---------------------------------------------------------------------------

/** 'MedRock Florida' + '2026-03' → 'FL Inv Open 2026.03' — distinct from the
 *  monthly close's 'FL Inv Adj 2026.03' so the two never collide in QB search. */
export function openingCorrectionDocNumber(location: string, month: string): string {
  return `${shortInventoryLocation(location)} Inv Open ${month.replace('-', '.')}`;
}

/** The correction's own pay_group, so its drafts never collide with the monthly
 *  close's month-end ones in the header table's natural key. Canonical HERE, in the
 *  pure module, because `je-identity` needs it to tell a correction from a close and
 *  must not pull in close-server's RDS/QuickBooks dependencies to do it. */
export const INV_OPEN_PAY_GROUP = 'INV OPEN';

/** The PrivateNote the correction posts under. Shared by the post route and
 *  `deriveJeIdentity` so the QBO import CSV cannot describe the entry differently
 *  from the way the Post button writes it. */
export const OPENING_CORRECTION_NOTE =
  'Opening inventory correction to FIFO method — one-time cutover (2026-03-01)';

/** One computed correction row plus its evidence (server-side superset of the
 *  client's OpeningCorrectionRowView). */
export interface OpeningCorrectionRowCalc {
  qbCategory: string | null;
  account: string;
  book: number;
  fifo: number;
  adjustment: number;
  mapped: boolean;
  receiptIds: string[];
}

/**
 * The correction rows for one location: every MAPPED category account is set to
 * its FIFO opening (including book-only accounts the FIFO ledger has no value
 * for — those zero out), and every residual category (Uncoded etc.) aggregates
 * to ONE parent-account row, same single-parent-balance discipline as
 * `buildCategoryJE`. Out-of-scope sub-accounts (OTC, Shipping, Suspense) are
 * simply never mentioned — untouched by construction, not by filtering.
 */
export function buildOpeningCorrectionRows(
  location: string,
  categoryValues: CategoryLedgerValue[],
  bsAccounts: ReadonlyArray<{ name: string; value: number }>,
  accountNums: Record<string, string>,
): OpeningCorrectionRowCalc[] {
  const mine = categoryValues.filter((c) => c.location === location);
  const rows: OpeningCorrectionRowCalc[] = [];

  for (const [qbCategory, pair] of Object.entries(CATEGORY_ACCOUNT_MAP)) {
    const book = round2(matchBalanceSheetAccount(pair.inventory, accountNums, bsAccounts) ?? 0);
    const cat = mine.find((c) => c.qbCategory === qbCategory);
    const fifo = round2(cat?.endingValue ?? 0);
    if (book === 0 && fifo === 0) continue;
    rows.push({
      qbCategory,
      account: pair.inventory,
      book,
      fifo,
      adjustment: round2(fifo - book),
      mapped: true,
      receiptIds: cat?.receiptIds ?? [],
    });
  }

  const residual = mine.filter((c) => !accountsForCategory(c.qbCategory).mapped);
  if (residual.length > 0) {
    const fifo = round2(residual.reduce((s, c) => s + c.endingValue, 0));
    const book = round2(matchBalanceSheetAccount(INVENTORY_ACCOUNT, accountNums, bsAccounts) ?? 0);
    if (fifo !== 0 || book !== 0) {
      rows.push({
        qbCategory: [...new Set(residual.map((c) => c.qbCategory))].sort().join(' + '),
        account: INVENTORY_ACCOUNT,
        book,
        fifo,
        adjustment: round2(fifo - book),
        mapped: false,
        receiptIds: [...new Set(residual.flatMap((c) => c.receiptIds))],
      });
    }
  }

  return rows;
}

export interface CorrectionPostingLine extends JeLine {
  receiptIds: string[];
}

/**
 * The balanced correction JE for one location: each row's inventory account is
 * set to its FIFO opening (Dr when FIFO exceeds book, Cr when below), with ONE
 * offset line to the correction account for the net. Returns [] when nothing
 * adjusts. Amounts are rounded per row and the offset is the sum of the rounded
 * rows, so the entry balances to the cent by construction.
 */
export function openingCorrectionLines(
  rows: OpeningCorrectionRowCalc[],
  offsetAccount: string,
  bookAsOf: string,
): CorrectionPostingLine[] {
  const out: CorrectionPostingLine[] = [];
  let net = 0;
  for (const row of rows) {
    if (row.adjustment === 0) continue;
    net = round2(net + row.adjustment);
    const amount = round2(Math.abs(row.adjustment));
    const label = row.qbCategory ?? row.account;
    const memo =
      `Set ${label} to FIFO opening $${row.fifo.toFixed(2)} ` +
      `(book $${row.book.toFixed(2)} as of ${bookAsOf}) — one-time cutover`;
    out.push({
      account: row.account,
      debit: row.adjustment > 0 ? amount : null,
      credit: row.adjustment < 0 ? amount : null,
      memo,
      receiptIds: row.receiptIds,
    });
  }
  if (out.length === 0) return [];
  const offsetAmount = round2(Math.abs(net));
  if (offsetAmount !== 0) {
    out.push({
      account: offsetAccount,
      debit: net < 0 ? offsetAmount : null,
      credit: net > 0 ? offsetAmount : null,
      memo: 'Opening inventory correction to FIFO method — one-time cutover offset',
      receiptIds: [],
    });
  }
  return out;
}
