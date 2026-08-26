/**
 * Shared types for the FIFO inventory valuation feature.
 * Mirrors the inventory.* tables in AWS RDS (MedDotsPBI).
 */

export type Basis = 'accrual' | 'cash';

export interface ValuationSummaryRow {
  as_of_month: string;
  location: string;
  qb_category: string;
  basis: Basis;
  on_hand_qty: number;
  on_hand_value_fifo: number;
  receipts_value_in_month: number;
  consumed_value_in_month: number;
  opening_balance_value: number;
  shortfall_count: number;
  lifefile_qty_left_total: number | null;
  /** Cash-basis rows only: on-hand value recognized at estimated dates (unlinked receipts + OB) */
  cash_estimated_value: number | null;
  /**
   * Purchases made before this (location x slice)'s usage floor, held OUT of
   * valuation as an auditable bucket (Florida's Pioneer-era compounding, mainly).
   * Written on every month from the group's floor forward; null before the
   * floor and on rows written before the 2026-08-25 floors rebuild.
   */
  pre_floor_collapsed_value: number | null;
  /**
   * The month's documented-disposal write-off (the deducted portion of the lot
   * adjustment log) and count-residual shrink — together the 5000.55 JE line.
   * Null on rows written before the 2026-08-26 adjustment-feed deploy.
   */
  waste_value_in_month: number | null;
  shrink_value_in_month: number | null;
}

export interface SummaryResponse {
  basis: Basis;
  months: string[];
  locations: string[];
  categories: string[];
  rows: ValuationSummaryRow[];
  latestMonth: string | null;
  /** true once the Data Loader writes basis='cash' rows (Phase 4 QB linkage) */
  hasCashBasis: boolean;
  /**
   * Months whose ledger is anchored to LifeFile actuals: the current month
   * lot-by-lot, plus every count-anchored month-end in the anchor window
   * (2026-08-26 model — recognizable by a written waste/shrink figure). Months
   * outside this list are simulation-only history and never receive entries.
   */
  anchoredMonths: string[];
}

/**
 * One row of inventory.fifo_rollback_valuation — the backward-rollback
 * reconstruction that values historical months from LifeFile lot actuals.
 * value_floor = receipt-priced stock only (conservative); value_full = all
 * visible stock with estimated costs where receipts are missing. The table may
 * not exist yet (loader phase pending) — the API returns [] in that case.
 */
export interface RollbackValuationRow {
  as_of_month: string;
  location: string;
  value_floor: number | null;
  value_full: number | null;
  on_hand_qty: number | null;
  uncosted_qty: number | null;
  lambda_config: string | null;
  fit_month: string | null;
  test_month: string | null;
  oos_ratio: number | null;
}

export interface RollbackResponse {
  rows: RollbackValuationRow[];
}

/**
 * Monthly-close roll-forward & suggested JE (built on the rollback dual-basis
 * valuation). See docs/superpowers/specs/2026-07-10-fifo-monthly-close-design.md
 * (superseded in part by the rollback amendments). All values are for the
 * selected `CloseBasis`: 'floor' = receipt-priced value/purchases, 'full' =
 * full-coverage estimate.
 */
export type CloseBasis = 'floor' | 'full';

/**
 * One roll-forward line: Beginning + Purchases − Ending = COGS (derived).
 * `beginning`/`cogs` are null at the window start (earliest month, no prior row).
 * `purchases`/`cogs` are null when the loader's purchases columns are pending
 * (not yet written to RDS) — the UI then shows the pending notice instead of math.
 */
export interface RollForwardRow {
  cut: 'total' | 'location';
  label: string; // 'Total' | 'MedRock FL' | ...
  beginning: number | null;
  purchases: number | null;
  cogs: number | null; // derived: beginning + purchases − ending
  ending: number;
  windowStart: boolean; // earliest month in the table → no prior beginning
  purchasesPending: boolean; // purchases column missing/NULL for this row
}

/** One QB inventory-asset sub-account line (name + point-in-time balance). */
export interface QbAccountLine {
  name: string;
  value: number;
}

/**
 * Suggested adjusting JE inputs for one location. Adjustment = FIFO target
 * (selected basis Ending) − QB book inventory-asset balance. Positive → Dr
 * Inventory / Cr COGS; negative → the reverse. Nothing is posted to QuickBooks.
 */
export interface LocationJE {
  location: string;
  fifoTarget: number;
  qbBookBalance: number | null; // null when the realm is disconnected / section missing
  qbAccounts: QbAccountLine[]; // sub-account breakdown for display (empty when unavailable)
  bookAvailable: boolean;
  adjustment: number | null; // fifoTarget − qbBookBalance (null when book unavailable)
  direction: 'debit-inventory' | 'credit-inventory' | 'none' | null;
}

/** Stored inventory-close draft header — client mirror of the payroll store's
 *  PayrollHeader, narrowed to what the close UI renders (the store module pulls
 *  in `pg` and must never land in a client bundle). */
export interface InvCloseHeader {
  id: number;
  /** QB token naming ('MedRock FL') — translate for display against RDS names. */
  entity: string;
  status: 'draft' | 'needs_review' | 'approved' | 'posted' | 'error';
  qb_doc_number: string | null;
  txn_date: string | null;
  total_debits: number;
  total_credits: number;
  variance: number;
}

/** Stored draft line — what will actually post, frozen at generation time. */
export interface InvCloseLine {
  postingType: 'Debit' | 'Credit';
  amount: number;
  accountName: string;
  memo: string;
}

/**
 * CATEGORY-GRAIN CLOSE (2026-08-24)
 *
 * The category path values inventory from inventory.lot_depletion_ledger (the
 * lot-level pipeline behind the Inventory Valuation page), NOT from
 * inventory.fifo_rollback_valuation (the location-only backward reconstruction
 * that the LocationJE path above uses). The two disagree substantially for
 * non-anchored months — that is expected and both are shown side by side. See
 * docs/superpowers/specs/2026-08-24-inventory-close-category-lot-detail-design.md.
 */

/** One roll-forward line at (location, category) grain. */
export interface CategoryRollForwardRow {
  location: string;
  qbCategory: string;
  beginning: number | null; // null at the earliest month in the ledger
  ending: number;
  /** Distinct receipt_ids behind `ending` — the drill-down key set. */
  receiptIds: string[];
  /** Count of lots contributing, for an at-a-glance "is this one lot or 400". */
  lotCount: number;
}

/**
 * One category's COMPARISON row (FIFO vs. book) within a location's entry — the
 * on-screen/workbook table grain. NOT a posting line: unmapped categories share
 * one aggregated posting pair (see `CategoryPostingLine` in lib/inventory/
 * monthly-close), so these rows and the emitted JE lines are 1:1 only for
 * mapped categories.
 */
export interface CategoryComparisonRow {
  qbCategory: string;
  /** QB FullyQualifiedName of the inventory-asset account this line adjusts. */
  inventoryAccount: string;
  /** QB FullyQualifiedName of the COGS account taking the offset. */
  cogsAccount: string;
  /** false when the category fell back to the parent accounts (residual line). */
  mapped: boolean;
  fifoTarget: number;
  /**
   * Book balance of `inventoryAccount`; null when unavailable/never funded.
   *
   * RESIDUAL ROWS: every unmapped category resolves to the SAME parent account,
   * so the parent balance is not attributable per category. It is claimed ONCE,
   * by the first (largest) residual row; the rest read $0. That keeps the rows
   * footing exactly to the single aggregated residual pair that actually posts —
   * see `categoryJournalEntryLinesWithSources`.
   */
  qbBookBalance: number | null;
  adjustment: number | null; // fifoTarget − qbBookBalance
  direction: 'debit-inventory' | 'credit-inventory' | 'none' | null;
  receiptIds: string[];
  lotCount: number;
}

/** A location's category-grain entry — the sum of its category lines. */
export interface CategoryJE {
  location: string;
  lines: CategoryComparisonRow[];
  /** Σ line.fifoTarget — what the categorized entry brings the books to. */
  fifoTarget: number;
  /** Σ line.adjustment (skipping nulls) — equals what the emitted JE posts. */
  adjustment: number;
  /** false when the QB realm gave no balance sheet at all. */
  bookAvailable: boolean;
  /** Categories that fell back to parent accounts, for the warnings banner. */
  unmappedCategories: string[];
  /**
   * The parent inventory account's book balance, read ONCE for the whole
   * location. The aggregated residual pair is compared against this — two
   * unmapped categories each subtracting it would double-count the parent
   * balance. null when the balance sheet is unavailable.
   */
  residualBookBalance: number | null;
}

/**
 * OPENING CORRECTION (2026-08-26) — the one-time cutover JE that trues the QB
 * inventory sub-accounts to the FIFO opening at the settled stop point
 * (2026-03-01), per docs/fifo-monthly-close/2026-08-26-correction-je-proposal.md.
 * Rendered as a card on the Inventory Close tab when the cutover month is
 * selected; same Generate → Approve → Post workflow, pay_group 'INV OPEN'.
 */
export interface OpeningCorrectionRowView {
  /** FIFO category behind the row; null for a book-only account being zeroed. */
  qbCategory: string | null;
  /** QB FullyQualifiedName of the inventory account this row sets. */
  account: string;
  /** Book balance as of the stop-point eve (2026-02-28). */
  book: number;
  /** FIFO opening (prior-month ledger ending). */
  fifo: number;
  /** fifo − book. Negative → credit inventory (write-down). */
  adjustment: number;
  /** false = the aggregated residual row on the parent account. */
  mapped: boolean;
}

export interface OpeningCorrectionLocation {
  /** RDS naming ('MedRock Florida'). */
  location: string;
  bookAvailable: boolean;
  /** true when the offset account exists in this company's chart. */
  offsetFound: boolean;
  rows: OpeningCorrectionRowView[];
  /** Σ row.adjustment — the net write-down (negative) this JE books. */
  netAdjustment: number;
}

export interface OpeningCorrection {
  /** 'YYYY-MM' the correction belongs to (the cutover month). */
  cutoverMonth: string;
  /** JE date — first day of the open period, never inside settled months. */
  openingDate: string;
  /** The book-balance as-of date (stop-point eve). */
  bookAsOf: string;
  /** QB FullyQualifiedName of the offset account (Kristi's §4 decision). */
  offsetAccount: string;
  locations: OpeningCorrectionLocation[];
  /** Stored correction drafts (pay_group 'INV OPEN'). */
  headers: InvCloseHeader[];
  linesById: Record<string, InvCloseLine[]>;
}

export interface MonthlyCloseResponse {
  month: string; // 'YYYY-MM'
  monthEnd: string; // 'YYYY-MM-DD' (last day of month)
  basis: CloseBasis;
  /** true once the loader's purchases_floor/full columns exist in RDS. */
  purchasesAvailable: boolean;
  rollForward: RollForwardRow[];
  journalEntries: LocationJE[];
  /** Stored drafts for this month (empty until Generate drafts is run). */
  headers: InvCloseHeader[];
  /** headerId (as string) -> stored draft lines. */
  linesById: Record<string, InvCloseLine[]>;
  /** Category-grain roll-forward (lot-ledger sourced). Empty when unavailable. */
  categoryRollForward: CategoryRollForwardRow[];
  /** Category-grain entries — what actually generates/posts as of 2026-08-24. */
  categoryJournalEntries: CategoryJE[];
  /**
   * Non-null when the category grain FAILED (QB/ledger error) rather than being
   * legitimately empty. Empty `categoryJournalEntries` with this null means the
   * month genuinely has no categories; with a message it means the read broke —
   * generate must then refuse to delete existing drafts and must say why.
   */
  categoryUnavailable: string | null;
  /**
   * The one-time cutover correction — present only when the selected month IS
   * the cutover month (2026-03); null/absent otherwise.
   */
  openingCorrection?: OpeningCorrection | null;
}

export interface LotRow {
  receipt_id: string;
  location: string;
  product_key: string;
  date_received: string | null;
  ndc: string | null;
  product_name: string | null;
  lot_number: string | null;
  vendor: string | null;
  qb_category: string;
  qty_received: number | null;
  unit_cost: number | null;
  total_cost: number | null;
  qty_consumed: number;
  qty_remaining: number;
  remaining_value: number | null;
  fully_used_month: string | null;
  is_opening_balance: boolean;
  had_shortfall: boolean;
  /** For opening-balance rows: the balance snapshot month the estimate is "as of" */
  ob_as_of_month: string | null;
  /** Current-month depletion anchored to the LifeFile lot report (vs usage simulation) */
  lot_anchored: boolean;
}

/** One row per product in the main ledger table (lots aggregate beneath it) */
export interface ProductGroupRow {
  product_key: string;
  product_name: string | null;
  ndc: string | null;
  qb_category: string;
  locations: string;
  lot_count: number;
  open_lots: number;
  last_received: string | null;
  qty_consumed: number;
  qty_remaining: number;
  remaining_value: number | null;
  has_opening_balance: boolean;
  had_shortfall: boolean;
}

export interface LotsResponse {
  month: string | null;
  total: number;
  limit: number;
  offset: number;
  rows: ProductGroupRow[];
}

export interface ProductReceiptRow extends LotRow {
  fifo_position: number;
}

export interface ProductMonthRow {
  as_of_month: string;
  qty_remaining: number;
  remaining_value: number | null;
  cumulative_consumed: number;
  consumed_in_month: number;
}

export interface ProductDetailResponse {
  product_key: string;
  product_name: string | null;
  /** The month these receipts are stated as of — echoed back so the drill-down
   *  can caption itself, and so a caller can tell a fallback from its request. */
  month: string | null;
  locations: string[];
  receipts: ProductReceiptRow[];
  history: ProductMonthRow[];
}

/**
 * One (location, category) cell of the point-in-time value, at the SAME grain
 * the inventory-close JE posts — see lib/inventory/ledger-values.ts for why this
 * cannot be read off `fifo_valuation_summary`.
 */
export interface AsOfCategoryRow {
  month: string;
  location: string;
  qbCategory: string;
  value: number;
  /** Lots behind `value` — an at-a-glance "is this one lot or four hundred". */
  lotCount: number;
}

export interface AsOfResponse {
  /** Every month the lot ledger holds, ascending. */
  months: string[];
  /** null only when the ledger is empty. */
  latestMonth: string | null;
  /** The whole history — the page cuts it per month client-side. */
  rows: AsOfCategoryRow[];
}
