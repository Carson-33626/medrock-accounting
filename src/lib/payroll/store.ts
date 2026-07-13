/**
 * RDS persistence for the payroll JE feature (accounting.payroll_* tables,
 * created in Task 3.1). Holds the pure sourceSnapshotHash plus DB CRUD used
 * by the /payroll API routes (later phase).
 */
import { createHash } from 'node:crypto';
import { getRdsPool } from '../rds';
import type {
  PayrollRow,
  JournalDraft,
  JournalLine,
  AccountMapRule,
  EmployeeMapRule,
  Entity,
  PostingType,
  CreditBucket,
  LineOrigin,
} from './types';

export type HeaderStatus = 'draft' | 'needs_review' | 'approved' | 'posted' | 'error';

/** Arbitrary JSON persisted to a jsonb column — explicitly typed (no any/unknown). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface PayrollHeader {
  id: number;
  entity: Entity;
  pay_date: string;
  pay_group: string;
  period_start: string | null;
  period_end: string | null;
  status: HeaderStatus;
  total_debits: number;
  total_credits: number;
  variance: number;
  row_count: number;
  source_snapshot_hash: string | null;
  qb_entry_id: string | null;
  qb_doc_number: string | null;
}

export function sourceSnapshotHash(rows: PayrollRow[]): string {
  const parts = rows.map((r) => `${r.row_key}=${r.updated_at}`).sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

interface AccountMapRow {
  id: number;
  entity: Entity;
  adpColumn: string;
  costCenter: string;
  accountName: string;
  postingType: PostingType;
  isCogs: boolean;
  creditBucket: CreditBucket | null;
  active: boolean;
}

export async function getAccountMap(entity: Entity): Promise<AccountMapRule[]> {
  const { rows } = await getRdsPool().query<AccountMapRow>(
    `SELECT id, entity, adp_column AS "adpColumn", cost_center AS "costCenter", account_name AS "accountName",
            posting_type AS "postingType", is_cogs AS "isCogs", credit_bucket AS "creditBucket", active
     FROM accounting.payroll_account_map WHERE entity=$1 AND active`,
    [entity],
  );
  return rows;
}

interface EmployeeMapRow {
  id: number;
  entity: Entity;
  positionId: string;
  departmentName: string | null;
  className: string | null;
  cogsOverride: boolean | null;
  active: boolean;
}

export async function getEmployeeMap(entity: Entity): Promise<EmployeeMapRule[]> {
  const { rows } = await getRdsPool().query<EmployeeMapRow>(
    `SELECT id, entity, position_id AS "positionId", department_name AS "departmentName", class_name AS "className",
            cogs_override AS "cogsOverride", active
     FROM accounting.payroll_employee_map WHERE entity=$1 AND active`,
    [entity],
  );
  return rows;
}

export async function upsertAccountRule(rule: AccountMapRule): Promise<number> {
  const { rows } = await getRdsPool().query<{ id: number }>(
    `INSERT INTO accounting.payroll_account_map
       (entity, adp_column, cost_center, account_name, posting_type, is_cogs, credit_bucket, active, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (entity, adp_column, cost_center, posting_type, account_name) DO UPDATE SET
       is_cogs = EXCLUDED.is_cogs,
       credit_bucket = EXCLUDED.credit_bucket,
       active = EXCLUDED.active,
       updated_at = now()
     RETURNING id`,
    [rule.entity, rule.adpColumn, rule.costCenter, rule.accountName, rule.postingType, rule.isCogs, rule.creditBucket, rule.active],
  );
  return rows[0].id;
}

export async function upsertEmployeeRule(rule: EmployeeMapRule): Promise<number> {
  const { rows } = await getRdsPool().query<{ id: number }>(
    `INSERT INTO accounting.payroll_employee_map
       (entity, position_id, department_name, class_name, cogs_override, active, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (entity, position_id) DO UPDATE SET
       department_name = EXCLUDED.department_name,
       class_name = EXCLUDED.class_name,
       cogs_override = EXCLUDED.cogs_override,
       active = EXCLUDED.active,
       updated_at = now()
     RETURNING id`,
    [rule.entity, rule.positionId, rule.departmentName, rule.className, rule.cogsOverride, rule.active],
  );
  return rows[0].id;
}

export async function updateAccountRule(id: number, rule: AccountMapRule): Promise<void> {
  await getRdsPool().query(
    `UPDATE accounting.payroll_account_map
     SET entity=$2, adp_column=$3, cost_center=$4, account_name=$5, posting_type=$6, is_cogs=$7,
         credit_bucket=$8, active=$9, updated_at=now()
     WHERE id=$1`,
    [id, rule.entity, rule.adpColumn, rule.costCenter, rule.accountName, rule.postingType, rule.isCogs, rule.creditBucket, rule.active],
  );
}

export async function updateEmployeeRule(id: number, rule: EmployeeMapRule): Promise<void> {
  await getRdsPool().query(
    `UPDATE accounting.payroll_employee_map
     SET entity=$2, position_id=$3, department_name=$4, class_name=$5, cogs_override=$6, active=$7, updated_at=now()
     WHERE id=$1`,
    [id, rule.entity, rule.positionId, rule.departmentName, rule.className, rule.cogsOverride, rule.active],
  );
}

export async function deleteAccountRule(id: number): Promise<void> {
  await getRdsPool().query(`DELETE FROM accounting.payroll_account_map WHERE id=$1`, [id]);
}

export async function deleteEmployeeRule(id: number): Promise<void> {
  await getRdsPool().query(`DELETE FROM accounting.payroll_employee_map WHERE id=$1`, [id]);
}

export async function saveDraft(draft: JournalDraft, snapshotHash: string): Promise<number> {
  const pool = getRdsPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // C1 SAFETY GATE: never let a re-run of the draft builder reset an already-posted
    // header back to 'needs_review' and wipe its lines — that would defeat the
    // double-post guard in decidePost/the post route. Lock the row (if any) and bail
    // out of the upsert entirely when it's already posted.
    const existing = await client.query<{ id: number; status: HeaderStatus }>(
      `SELECT id, status FROM accounting.payroll_journal_headers
       WHERE entity = $1 AND pay_date = $2 AND pay_group = $3
       FOR UPDATE`,
      [draft.entity, draft.payDate, draft.payGroup],
    );
    const existingRow = existing.rows[0];
    if (existingRow && existingRow.status === 'posted') {
      await client.query('COMMIT');
      return existingRow.id;
    }

    const headerRes = await client.query<{ id: number }>(
      `INSERT INTO accounting.payroll_journal_headers
         (entity, pay_date, pay_group, period_start, period_end, status,
          total_debits, total_credits, variance, row_count, source_snapshot_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'needs_review', $6, $7, $8, $9, $10, now())
       ON CONFLICT (entity, pay_date, pay_group) DO UPDATE SET
         period_start = EXCLUDED.period_start,
         period_end = EXCLUDED.period_end,
         status = 'needs_review',
         total_debits = EXCLUDED.total_debits,
         total_credits = EXCLUDED.total_credits,
         variance = EXCLUDED.variance,
         row_count = EXCLUDED.row_count,
         source_snapshot_hash = EXCLUDED.source_snapshot_hash,
         updated_at = now()
       RETURNING id`,
      [
        draft.entity,
        draft.payDate,
        draft.payGroup,
        draft.periodStart,
        draft.periodEnd,
        draft.totalDebits,
        draft.totalCredits,
        draft.variance,
        draft.rowKeys.length,
        snapshotHash,
      ],
    );
    const headerId = headerRes.rows[0].id;

    await client.query(`DELETE FROM accounting.payroll_journal_lines WHERE header_id = $1`, [headerId]);

    for (let i = 0; i < draft.lines.length; i++) {
      const line = draft.lines[i];
      await client.query(
        `INSERT INTO accounting.payroll_journal_lines
           (header_id, posting_type, amount, account_name, department_name, class_name, memo,
            credit_bucket, origin, source_row_keys, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          headerId,
          line.postingType,
          line.amount,
          line.accountName,
          line.departmentName,
          line.className,
          line.memo,
          line.creditBucket,
          line.origin,
          line.sourceRowKeys,
          i,
        ],
      );
    }

    await client.query('COMMIT');
    return headerId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

interface HeaderRow {
  id: number;
  entity: Entity;
  pay_date: string;
  pay_group: string;
  period_start: string | null;
  period_end: string | null;
  status: HeaderStatus;
  total_debits: string;
  total_credits: string;
  variance: string;
  row_count: number;
  source_snapshot_hash: string | null;
  qb_entry_id: string | null;
  qb_doc_number: string | null;
}

function toHeader(r: HeaderRow): PayrollHeader {
  return {
    // `id` is a bigint — node-postgres returns bigint as a string. Coerce so every
    // consumer (reconcile/approve/post routes require typeof headerId === 'number')
    // gets a real number. IDs are far below Number.MAX_SAFE_INTEGER, so this is safe.
    id: Number(r.id),
    entity: r.entity,
    pay_date: r.pay_date,
    pay_group: r.pay_group,
    period_start: r.period_start,
    period_end: r.period_end,
    status: r.status,
    total_debits: Number(r.total_debits),
    total_credits: Number(r.total_credits),
    variance: Number(r.variance),
    row_count: r.row_count,
    source_snapshot_hash: r.source_snapshot_hash,
    qb_entry_id: r.qb_entry_id,
    qb_doc_number: r.qb_doc_number,
  };
}

interface LineRow {
  posting_type: PostingType;
  amount: string;
  account_name: string;
  department_name: string | null;
  class_name: string | null;
  memo: string | null;
  credit_bucket: CreditBucket | null;
  origin: LineOrigin;
  source_row_keys: string[];
}

function toLine(r: LineRow): JournalLine {
  return {
    postingType: r.posting_type,
    amount: Number(r.amount),
    accountName: r.account_name,
    departmentName: r.department_name,
    className: r.class_name,
    memo: r.memo ?? '',
    creditBucket: r.credit_bucket,
    origin: r.origin,
    sourceRowKeys: r.source_row_keys,
  };
}

export async function loadDraft(id: number): Promise<{ header: PayrollHeader; lines: JournalLine[] } | null> {
  const pool = getRdsPool();
  const headerRes = await pool.query<HeaderRow>(
    `SELECT id, entity, pay_date, pay_group, period_start, period_end, status,
            total_debits, total_credits, variance, row_count, source_snapshot_hash, qb_entry_id, qb_doc_number
     FROM accounting.payroll_journal_headers WHERE id = $1`,
    [id],
  );
  const headerRow = headerRes.rows[0];
  if (!headerRow) return null;

  const linesRes = await pool.query<LineRow>(
    `SELECT posting_type, amount, account_name, department_name, class_name, memo,
            credit_bucket, origin, source_row_keys
     FROM accounting.payroll_journal_lines
     WHERE header_id = $1
     ORDER BY sort_order`,
    [id],
  );

  return { header: toHeader(headerRow), lines: linesRes.rows.map(toLine) };
}

export async function listHeaders(startISO: string, endISO: string): Promise<PayrollHeader[]> {
  const { rows } = await getRdsPool().query<HeaderRow>(
    `SELECT id, entity, pay_date, pay_group, period_start, period_end, status,
            total_debits, total_credits, variance, row_count, source_snapshot_hash, qb_entry_id, qb_doc_number
     FROM accounting.payroll_journal_headers
     WHERE to_date(pay_date, 'MM/DD/YYYY') BETWEEN $1::date AND $2::date
     ORDER BY pay_date, entity`,
    [startISO, endISO],
  );
  return rows.map(toHeader);
}

/**
 * Headers for the most recent `periods` distinct pay dates (default 2), newest first.
 * Powers the /payroll landing list — no date range needed; the accountant sees the
 * last couple of pay periods already populated and clicks straight into a draft.
 */
export async function listRecentHeaders(periods = 2): Promise<PayrollHeader[]> {
  const safePeriods = Number.isFinite(periods) && periods > 0 ? Math.min(Math.floor(periods), 24) : 2;
  const { rows } = await getRdsPool().query<HeaderRow>(
    `WITH recent AS (
       SELECT DISTINCT to_date(pay_date, 'MM/DD/YYYY') AS d
       FROM accounting.payroll_journal_headers
       ORDER BY d DESC
       LIMIT $1
     )
     SELECT id, entity, pay_date, pay_group, period_start, period_end, status,
            total_debits, total_credits, variance, row_count, source_snapshot_hash, qb_entry_id, qb_doc_number
     FROM accounting.payroll_journal_headers
     WHERE to_date(pay_date, 'MM/DD/YYYY') IN (SELECT d FROM recent)
     ORDER BY to_date(pay_date, 'MM/DD/YYYY') DESC, entity, pay_group`,
    [safePeriods],
  );
  return rows.map(toHeader);
}

export interface AuditEntry {
  headerId: number | null;
  mode: 'dry_run' | 'live';
  entity: Entity;
  qbRealm?: string;
  qbDocNumber?: string;
  qbEntryId?: string;
  outcome: string;
  requestPayload?: JsonValue;
  responseStatus?: number;
  responseBody?: JsonValue;
  reason?: string;
}

export async function insertAudit(entry: AuditEntry): Promise<void> {
  await getRdsPool().query(
    `INSERT INTO accounting.payroll_post_audit
       (header_id, mode, entity, qb_realm, qb_doc_number, qb_entry_id, outcome,
        request_payload, response_status, response_body, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.headerId,
      entry.mode,
      entry.entity,
      entry.qbRealm ?? null,
      entry.qbDocNumber ?? null,
      entry.qbEntryId ?? null,
      entry.outcome,
      entry.requestPayload === undefined ? null : JSON.stringify(entry.requestPayload),
      entry.responseStatus ?? null,
      entry.responseBody === undefined ? null : JSON.stringify(entry.responseBody),
      entry.reason ?? null,
    ],
  );
}

export async function setHeaderStatus(
  id: number,
  status: HeaderStatus,
  qb?: { entryId?: string; docNumber?: string },
): Promise<void> {
  await getRdsPool().query(
    `UPDATE accounting.payroll_journal_headers
     SET status = $2,
         qb_entry_id = COALESCE($3, qb_entry_id),
         qb_doc_number = COALESCE($4, qb_doc_number),
         updated_at = now()
     WHERE id = $1`,
    [id, status, qb?.entryId ?? null, qb?.docNumber ?? null],
  );
}
