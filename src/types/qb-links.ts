/**
 * Types for Phase 4 — QuickBooks purchase linkage.
 * Mirrors inventory.qb_documents + inventory.qb_purchase_links in AWS RDS
 * (web-owned tables; NOT rebuilt by the nightly fifo_transform).
 * Spec: docs/superpowers/specs/2026-06-12-fifo-qb-purchase-linkage.md
 */

export type QbDocType = 'Bill' | 'Purchase';
export type QbLinkStatus = 'auto' | 'review' | 'manual' | 'rejected' | 'unmatched';
/** A receipt with no link row yet (location never synced) */
export type QbLinkStatusOrUnsynced = QbLinkStatus | 'unsynced';
export type QbMatchMethod = 'vendor_amount' | 'amount_unique' | 'manual' | 'none';

export interface QbDocumentRow {
  qb_doc_key: string;
  location: string;
  doc_type: QbDocType;
  doc_id: string;
  vendor: string | null;
  vendor_norm: string | null;
  txn_date: string;
  total_amount: number;
  line_amounts: number[];
  paid_date: string | null;
  doc_number: string | null;
}

/** Joined receipt + link + QB doc row for the review table */
export interface QbLinkRow {
  receipt_id: string;
  location: string;
  date_received: string;
  vendor: string | null;
  product_name: string | null;
  total_cost: number;
  status: QbLinkStatusOrUnsynced;
  match_method: QbMatchMethod | null;
  confidence: number | null;
  qb_doc_key: string | null;
  doc_type: QbDocType | null;
  doc_id: string | null;
  qb_vendor: string | null;
  qb_txn_date: string | null;
  qb_paid_date: string | null;
  qb_total: number | null;
  decided_by: string | null;
  notes: string | null;
}

export interface QbStatusTotal {
  status: QbLinkStatusOrUnsynced;
  receipts: number;
  value: number;
}

export interface QbLinksResponse {
  rows: QbLinkRow[];
  totals: QbStatusTotal[];
  total: number;
  limit: number;
  offset: number;
  /** location -> latest qb_documents.synced_at (null if never synced) */
  lastSync: Record<string, string | null>;
}

export interface QbSyncResult {
  location: string;
  bills: number;
  purchases: number;
  billPayments: number;
  receipts: number;
  counts: Record<'auto' | 'review' | 'unmatched', number>;
  values: Record<'auto' | 'review' | 'unmatched', number>;
  preservedDecisions: number;
}

export interface QbCandidateRow extends QbDocumentRow {
  days_apart: number;
  /** receipt total_cost exactly equals a line amount or the doc total */
  amount_exact: boolean;
  vendor_match: boolean;
}

export interface QbCandidatesResponse {
  receipt_id: string;
  receipt: {
    date_received: string;
    vendor: string | null;
    product_name: string | null;
    total_cost: number;
    location: string;
  };
  candidates: QbCandidateRow[];
}

export interface QbDecideRequest {
  receipt_id: string;
  action: 'link' | 'reject' | 'reset';
  qb_doc_key?: string;
  decided_by?: string;
  notes?: string;
}
