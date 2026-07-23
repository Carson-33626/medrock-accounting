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
   * Months whose ledger is anchored to LifeFile actuals (vs. raw usage simulation).
   * Today only the current month is anchored (Phase 2b/2c); historical months become
   * anchored once Phase 2d lands. Used to badge an as-of value as reconciled vs. estimate.
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
  locations: string[];
  receipts: ProductReceiptRow[];
  history: ProductMonthRow[];
}
