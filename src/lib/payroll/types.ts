export type SensitiveRow = Record<string, number | string | null>;

export interface PayrollRow {
  position_id: string; name: string; status: string; worker_classification: string;
  home_department: string; location: string; pay_date: string; pay_num: string;
  pay_frequency: string; pay_group: string; pay_type: string; period_start_date: string;
  period_end_date: string; processed_as: string; rate_type: string; sui_sdi_tax_code: string;
  row_key: string; updated_at: string; sensitive: SensitiveRow;
}

export type Entity = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';
export type PostingType = 'Debit' | 'Credit';
export type LineOrigin = 'generated' | 'manual' | 'inter_entity';
export type JeKind = 'pay_date' | 'accrual' | 'reversal' | 'allocation';
export type CreditBucket = 'Net Pay' | 'Taxes' | 'Garnishments' | 'Retirement' | 'Health' | 'WC' | 'Other';

export interface JournalLine {
  postingType: PostingType;
  amount: number; // dollars, 2dp
  accountName: string;
  departmentName: string | null;
  className: string | null;
  memo: string;
  creditBucket: CreditBucket | null;
  origin: LineOrigin;
  sourceRowKeys: string[];
}

export interface JournalDraft {
  entity: Entity;
  payDate: string; payGroup: string; periodStart: string; periodEnd: string;
  lines: JournalLine[];
  totalDebits: number; totalCredits: number; variance: number;
  rowKeys: string[];
  /** Which of the four JE kinds this draft is. Absent === 'pay_date' (the original path). */
  kind?: JeKind;
  /** Per-draft QB overrides for the special (accrual/reversal/allocation) JEs. When present,
   *  buildJePayload uses these verbatim instead of deriving from payDate — so those JEs get
   *  Amy's DocNumber/TxnDate scheme while the pay-date path stays byte-identical. */
  docNumber?: string;
  txnDate?: string;    // ISO YYYY-MM-DD
  privateNote?: string;
}

export interface AccountMapRule {
  id?: number;
  entity: Entity; adpColumn: string; costCenter: string; accountName: string; postingType: PostingType;
  isCogs: boolean; creditBucket: CreditBucket | null; active: boolean;
  /** Department-labelled JE line memo (e.g. 'Accounting Wages', 'ER Taxes - Admin'). Splits lines
   * that share an account by department so accounting can read each department's slice. Null on
   * pooled '*' rules (credits, EE withholdings) — those fall back to the creditBucket memo. */
  memo?: string | null;
}
export interface EmployeeMapRule {
  id?: number;
  entity: Entity; positionId: string; departmentName: string | null; className: string | null;
  cogsOverride: boolean | null; active: boolean;
}
export interface AllocationRule {
  id?: number;
  costCenter: string;
  targetEntity: Entity;
  percent: number;       // e.g. 33.3333
  effectiveFrom: string; // ISO YYYY-MM-DD
  active: boolean;
}
export interface ResolvedTarget {
  accountName: string; departmentName: string | null; className: string | null;
  postingType: PostingType; creditBucket: CreditBucket | null; isCogs?: boolean;
  /** Department-labelled line memo carried from the matched account-map rule (see AccountMapRule.memo). */
  memo?: string | null;
}

/** One person who contributed dollars to an unmapped column — name for display, rowKey to
 * drill into their (decrypt-gated) source detail. NO per-person amount here: those stay behind
 * the drill-down decrypt gate; only the column TOTAL is surfaced. */
export interface UnmappedColumnSource {
  rowKey: string;
  name: string;
}
/** An unmapped ADP column enriched for the "new columns detected" worklist: its total dollars
 * across the run + the people who carried them (so the panel can show the amount and jump to
 * source). Parallel to the bare `unmappedColumns: string[]` reconcile still uses for postability. */
export interface UnmappedColumnDetail {
  column: string;
  amount: number; // total $ across the run for this column, 2dp
  sources: UnmappedColumnSource[];
}
export interface ReconcileResult {
  balanced: boolean; variance: number;
  grossOk: boolean; netOk: boolean; taxesEeOk: boolean; taxesErOk: boolean;
  unmappedColumns: string[]; unmappedPositions: string[];
  errors: string[]; postable: boolean;
}
