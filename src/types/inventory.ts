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
}

export interface SummaryResponse {
  basis: Basis;
  months: string[];
  locations: string[];
  categories: string[];
  rows: ValuationSummaryRow[];
  latestMonth: string | null;
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
}

export interface LotsResponse {
  month: string | null;
  total: number;
  limit: number;
  offset: number;
  rows: LotRow[];
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
