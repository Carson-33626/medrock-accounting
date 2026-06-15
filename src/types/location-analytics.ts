/**
 * Types for the Location Analytics page — QuickBooks P&L per location (backbone)
 * cross-checked against RDS operational data (LifeFile dispensing sales + FIFO
 * COGS / on-hand). Read-only / investigative.
 * See docs/superpowers/specs/2026-06-15-location-analytics-modernization-design.md
 */

export type Basis = 'Cash' | 'Accrual';

/** QuickBooks P&L figures for one location (the books / backbone). */
export interface QbPnl {
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPercent: number;
  payrollTotal: number;
  operatingExpensesTotal: number;
  netIncome: number;
  netMarginPercent: number;
}

/** RDS-derived operational metrics for one location. */
export interface RdsMetrics {
  /** Σ Subtotal from source.sales_tax_report (all ship-to states) — dispensed sales. */
  lifefileSales: number;
  /** Σ consumed_value_in_month from inventory.fifo_valuation_summary; null when basis unavailable. */
  fifoCogs: number | null;
  /** Latest-month on_hand_value_fifo; null when basis unavailable. */
  onHandInventory: number | null;
  /** False when the selected basis has no FIFO rows (e.g. Cash before the loader ships cash rows). */
  fifoBasisAvailable: boolean;
}

/** QB-vs-RDS variance for one location (null when QB is not connected). */
export interface Reconciliation {
  revenueVariance: number; // qb.revenue - rds.lifefileSales
  revenueVariancePercent: number; // / qb.revenue
  revenueFlagged: boolean; // |%| > threshold
  cogsVariance: number | null; // qb.cogs - rds.fifoCogs (null when FIFO unavailable)
  cogsVariancePercent: number | null;
  cogsFlagged: boolean;
}

export interface LocationAnalyticsRow {
  qbLocation: string; // 'MedRock FL' | 'MedRock TN' | 'MedRock TX'
  label: string; // 'Florida' | 'Tennessee' | 'Texas'
  state: string; // 'FL' | 'TN' | 'TX'
  connected: boolean; // QB token present for this location
  qb: QbPnl | null; // null when not connected or QB fetch failed
  rds: RdsMetrics;
  reconciliation: Reconciliation | null;
}

export interface LocationAnalyticsTotals {
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPercent: number;
  payrollTotal: number;
  operatingExpensesTotal: number;
  netIncome: number;
  netMarginPercent: number;
  lifefileSales: number;
  fifoCogs: number | null;
  onHandInventory: number | null;
}

export interface LocationAnalyticsResponse {
  startDate: string;
  endDate: string;
  basis: Basis;
  varianceThresholdPercent: number;
  locations: LocationAnalyticsRow[];
  totals: LocationAnalyticsTotals;
  /** max(ingested_at) from source.sales_tax_report — data freshness. */
  feedAsOf: string | null;
  generatedAt: string;
}
