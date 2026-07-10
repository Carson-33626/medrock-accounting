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
}

export interface AccountMapRule {
  entity: Entity; adpColumn: string; accountName: string; postingType: PostingType;
  isCogs: boolean; creditBucket: CreditBucket | null; active: boolean;
}
export interface EmployeeMapRule {
  entity: Entity; positionId: string; departmentName: string | null; className: string | null;
  cogsOverride: boolean | null; active: boolean;
}
export interface ResolvedTarget {
  accountName: string; departmentName: string | null; className: string | null;
  postingType: PostingType; creditBucket: CreditBucket | null;
}
export interface ReconcileResult {
  balanced: boolean; variance: number;
  grossOk: boolean; netOk: boolean; taxesEeOk: boolean; taxesErOk: boolean;
  unmappedColumns: string[]; unmappedPositions: string[];
  errors: string[]; postable: boolean;
}
