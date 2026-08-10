/**
 * RDS persistence for the payroll JE feature (accounting.payroll_* tables,
 * created in Task 3.1). Holds the pure sourceSnapshotHash plus DB CRUD used
 * by the /payroll API routes (later phase).
 */
import { createHash } from 'node:crypto';
import { getRdsPool } from '../rds';
import { adpDateToIso } from './dates';
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

/**
 * `error` is RESERVED and deliberately never written. A post that fails leaves the header on
 * `approved` on purpose: `decidePost` only lets an `approved` header reach QuickBooks, so
 * stamping `error` would strand the run behind a re-approval before anyone could retry — the
 * opposite of "clearing these ourselves" (Barbara, 2026-08-06). Failures live in
 * `accounting.payroll_post_audit` (outcome `error` / `blocked`), which records every attempt
 * without changing what the run is allowed to do next.
 */
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
  kind: string;
  period_segment: string;
  /** ISO YYYY-MM-DD the JE posts on (segment month-end for a split prior-month piece,
   *  else the pay date). Drives the accounting-period filter. */
  txn_date: string | null;
  /**
   * How many pieces this run (entity + pay_date + pay_group) has IN TOTAL — counted
   * independently of the query's own date filter, so it stays truthful when a filter returns
   * only some of the siblings. `> 1` means the run is split. 1 on the single-header paths.
   */
  piece_count: number;
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
  memo: string | null;
}

export async function getAccountMap(entity: Entity): Promise<AccountMapRule[]> {
  const { rows } = await getRdsPool().query<AccountMapRow>(
    `SELECT id, entity, adp_column AS "adpColumn", cost_center AS "costCenter", account_name AS "accountName",
            posting_type AS "postingType", is_cogs AS "isCogs", credit_bucket AS "creditBucket", active, memo
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
  reviewed: boolean;
}

export async function getEmployeeMap(entity: Entity): Promise<EmployeeMapRule[]> {
  const { rows } = await getRdsPool().query<EmployeeMapRow>(
    `SELECT id, entity, position_id AS "positionId", department_name AS "departmentName", class_name AS "className",
            cogs_override AS "cogsOverride", active, reviewed
     FROM accounting.payroll_employee_map WHERE entity=$1 AND active`,
    [entity],
  );
  return rows;
}

/**
 * Enforce ONE active rule per (entity, adp_column, cost_center, posting_type) by deactivating
 * every other active rule in that slot.
 *
 * WHY THIS EXISTS: the upsert's natural key is five columns and INCLUDES account_name, so
 * re-pointing a mapping at a different account does not move the existing rule — it inserts a
 * second one and leaves the first ACTIVE. `resolveLine` returns EVERY in-direction match, so both
 * fire and the column is booked twice; meanwhile the accountant sees the old rule "come back" in
 * the panel. That is exactly what happened to MedRock FL's ADMIN overtime rules, which is what
 * Barbara reported as duplicates on 2026-08-06 (TODO.md).
 *
 * Deactivates rather than deletes: a superseded rule is history worth keeping, and getAccountMap
 * filters on `active`, so an inactive row is invisible to both the resolver and the panel.
 *
 * Only called for an ACTIVE incoming rule — saving a rule as inactive must not disturb whichever
 * rule is currently live in that slot. Returns how many were superseded.
 */
async function deactivateSupersededAccountRules(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> },
  rule: AccountMapRule,
  keepId: number,
): Promise<number> {
  if (!rule.active) return 0;
  const { rowCount } = await client.query(
    `UPDATE accounting.payroll_account_map
        SET active = false, updated_at = now()
      WHERE entity = $1 AND adp_column = $2 AND cost_center = $3 AND posting_type = $4
        AND id <> $5 AND active`,
    [rule.entity, rule.adpColumn, rule.costCenter, rule.postingType, keepId],
  );
  return rowCount ?? 0;
}

export async function upsertAccountRule(rule: AccountMapRule): Promise<number> {
  const client = await getRdsPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO accounting.payroll_account_map
         (entity, adp_column, cost_center, account_name, posting_type, is_cogs, credit_bucket, active, memo, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (entity, adp_column, cost_center, posting_type, account_name) DO UPDATE SET
         is_cogs = EXCLUDED.is_cogs,
         credit_bucket = EXCLUDED.credit_bucket,
         active = EXCLUDED.active,
         memo = EXCLUDED.memo,
         updated_at = now()
       RETURNING id`,
      [rule.entity, rule.adpColumn, rule.costCenter, rule.accountName, rule.postingType, rule.isCogs, rule.creditBucket, rule.active, rule.memo ?? null],
    );
    const id = rows[0].id;
    // Same transaction as the insert: a crash between the two would leave the double-booking
    // state this is here to prevent.
    await deactivateSupersededAccountRules(client, rule, id);
    await client.query('COMMIT');
    return id;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertEmployeeRule(rule: EmployeeMapRule): Promise<number> {
  const { rows } = await getRdsPool().query<{ id: number }>(
    `INSERT INTO accounting.payroll_employee_map
       (entity, position_id, department_name, class_name, cogs_override, active, reviewed, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (entity, position_id) DO UPDATE SET
       department_name = EXCLUDED.department_name,
       class_name = EXCLUDED.class_name,
       cogs_override = EXCLUDED.cogs_override,
       active = EXCLUDED.active,
       -- Sticky: once confirmed, a re-seed (which passes reviewed=false) must not un-confirm a
       -- marketer an accountant already reviewed. Un-reviewing is only possible via updateEmployeeRule.
       reviewed = payroll_employee_map.reviewed OR EXCLUDED.reviewed,
       updated_at = now()
     RETURNING id`,
    [rule.entity, rule.positionId, rule.departmentName, rule.className, rule.cogsOverride, rule.active, rule.reviewed ?? false],
  );
  return rows[0].id;
}

export async function updateAccountRule(id: number, rule: AccountMapRule): Promise<void> {
  const client = await getRdsPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE accounting.payroll_account_map
       SET entity=$2, adp_column=$3, cost_center=$4, account_name=$5, posting_type=$6, is_cogs=$7,
           credit_bucket=$8, active=$9, memo=$10, updated_at=now()
       WHERE id=$1`,
      [id, rule.entity, rule.adpColumn, rule.costCenter, rule.accountName, rule.postingType, rule.isCogs, rule.creditBucket, rule.active, rule.memo ?? null],
    );
    // An edit can MOVE a rule into a slot another active rule already occupies (change the cost
    // centre or the posting side and you land on top of an existing rule). Same invariant as the
    // insert path — see deactivateSupersededAccountRules.
    await deactivateSupersededAccountRules(client, rule, id);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function updateEmployeeRule(id: number, rule: EmployeeMapRule): Promise<void> {
  await getRdsPool().query(
    `UPDATE accounting.payroll_employee_map
     SET entity=$2, position_id=$3, department_name=$4, class_name=$5, cogs_override=$6, active=$7, reviewed=$8, updated_at=now()
     WHERE id=$1`,
    [id, rule.entity, rule.positionId, rule.departmentName, rule.className, rule.cogsOverride, rule.active, rule.reviewed ?? false],
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
       WHERE entity = $1 AND pay_date = $2 AND pay_group = $3 AND period_segment = $4
       FOR UPDATE`,
      [draft.entity, draft.payDate, draft.payGroup, draft.periodSegment ?? ''],
    );
    const existingRow = existing.rows[0];
    if (existingRow && existingRow.status === 'posted') {
      await client.query('COMMIT');
      return existingRow.id;
    }

    const headerRes = await client.query<{ id: number }>(
      `INSERT INTO accounting.payroll_journal_headers
         (entity, pay_date, pay_group, period_segment, kind, txn_date, period_start, period_end, status,
          total_debits, total_credits, variance, row_count, source_snapshot_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, 'needs_review', $9, $10, $11, $12, $13, now())
       ON CONFLICT (entity, pay_date, pay_group, period_segment) DO UPDATE SET
         kind = EXCLUDED.kind,
         txn_date = EXCLUDED.txn_date,
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
        draft.periodSegment ?? '',
        draft.kind ?? 'pay_date',
        draft.txnDate ?? adpDateToIso(draft.payDate),
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

export interface HeaderRow {
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
  kind: string;
  period_segment: string;
  txn_date: string | null;
  /** Absent on the single-header fetch paths; only the list queries select it. */
  piece_count?: string | null;
}

export function toHeader(r: HeaderRow): PayrollHeader {
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
    kind: r.kind,
    period_segment: r.period_segment,
    txn_date: r.txn_date,
    // Defaults to 1 on the single-header paths that don't select it. Never derive "is this run
    // split?" from how many siblings a query happened to return — see the SQL comment in
    // listHeaders for why that inference is unsafe under a date filter.
    piece_count: r.piece_count == null ? 1 : Number(r.piece_count),
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
            total_debits, total_credits, variance, row_count, source_snapshot_hash, qb_entry_id, qb_doc_number,
            kind, period_segment, to_char(txn_date,'YYYY-MM-DD') AS txn_date
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

/** All sibling pieces of one run (>=1 row; a single '' row for an unsplit run), month order. */
export async function listSiblings(entity: Entity, payDate: string, payGroup: string): Promise<PayrollHeader[]> {
  const { rows } = await getRdsPool().query<HeaderRow>(
    `SELECT id, entity, pay_date, pay_group, period_start, period_end, status,
            total_debits, total_credits, variance, row_count, source_snapshot_hash,
            qb_entry_id, qb_doc_number, kind, period_segment, to_char(txn_date,'YYYY-MM-DD') AS txn_date
     FROM accounting.payroll_journal_headers
     WHERE entity = $1 AND pay_date = $2 AND pay_group = $3
     ORDER BY period_segment`,
    [entity, payDate, payGroup],
  );
  return rows.map(toHeader);
}

/**
 * Regeneration replace-semantics: after re-saving a run's pieces, remove UNPOSTED leftovers
 * whose segment is no longer produced (covers split→unsplit if period dates were corrected).
 * Posted headers are never deleted. Lines cascade via the FK.
 */
export async function deleteStaleSiblings(
  entity: Entity, payDate: string, payGroup: string, keepSegments: string[],
): Promise<number> {
  const { rowCount } = await getRdsPool().query(
    `DELETE FROM accounting.payroll_journal_headers
     WHERE entity = $1 AND pay_date = $2 AND pay_group = $3
       AND status <> 'posted'
       AND NOT (period_segment = ANY($4::text[]))`,
    [entity, payDate, payGroup, keepSegments],
  );
  return rowCount ?? 0;
}

/** Pair-atomic status flip (approve both pieces of a split run in one statement). */
export async function setHeadersStatus(ids: number[], status: HeaderStatus): Promise<void> {
  if (ids.length === 0) return;
  await getRdsPool().query(
    `UPDATE accounting.payroll_journal_headers
     SET status = $2, updated_at = now()
     WHERE id = ANY($1::bigint[]) AND status <> 'posted'`,
    [ids, status],
  );
}

export async function listHeaders(startISO: string, endISO: string): Promise<PayrollHeader[]> {
  const { rows } = await getRdsPool().query<HeaderRow>(
    // piece_count is a correlated subquery, NOT a window function, and that is deliberate: a
    // window would be evaluated after the WHERE clause and so would only count the siblings
    // this filter returned. A split run's pieces carry txn_dates in DIFFERENT calendar months
    // (e.g. 2026-03-31 and 2026-04-10), so filtering to one month returns exactly one of them —
    // and the caller must still be able to tell that the run is split and that it is looking at
    // a partial view. Counting independently of the filter is the whole point.
    `SELECT h.id, h.entity, h.pay_date, h.pay_group, h.period_start, h.period_end, h.status,
            h.total_debits, h.total_credits, h.variance, h.row_count, h.source_snapshot_hash,
            h.qb_entry_id, h.qb_doc_number, h.kind, h.period_segment,
            to_char(h.txn_date,'YYYY-MM-DD') AS txn_date,
            (SELECT count(*) FROM accounting.payroll_journal_headers s
              WHERE s.entity = h.entity AND s.pay_date = h.pay_date
                AND s.pay_group = h.pay_group AND s.kind <> 'allocation')::text AS piece_count
     FROM accounting.payroll_journal_headers h
     WHERE COALESCE(h.txn_date, to_date(h.pay_date, 'MM/DD/YYYY')) BETWEEN $1::date AND $2::date
       AND h.kind <> 'allocation'
     ORDER BY to_date(h.pay_date, 'MM/DD/YYYY') DESC, h.entity, h.pay_group, h.period_segment`,
    [startISO, endISO],
  );
  return rows.map(toHeader);
}

/**
 * Upper bound on how many distinct pay dates the landing will page through.
 * Sized well above real history (33 built pay dates as of 2026-07, growing ~26/yr
 * plus off-cycle runs) so "Show more" reaches the oldest draft rather than
 * silently flat-lining. Still bounded so a bad `?recent=` can't table-scan.
 */
export const MAX_RECENT_PAY_PERIODS = 400;

/** How many distinct pay dates have built drafts — lets the UI know when it has them all. */
export async function countDistinctPayDates(): Promise<number> {
  const { rows } = await getRdsPool().query<{ n: string }>(
    `SELECT count(DISTINCT to_date(pay_date, 'MM/DD/YYYY'))::text AS n
     FROM accounting.payroll_journal_headers
     WHERE kind <> 'allocation'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Headers for the most recent `periods` distinct pay dates (default 2), newest first.
 * Powers the /payroll landing list — no date range needed; the accountant sees the
 * last couple of pay periods already populated and clicks straight into a draft.
 */
export async function listRecentHeaders(periods = 2): Promise<PayrollHeader[]> {
  const safePeriods =
    Number.isFinite(periods) && periods > 0 ? Math.min(Math.floor(periods), MAX_RECENT_PAY_PERIODS) : 2;
  const { rows } = await getRdsPool().query<HeaderRow>(
    `WITH recent AS (
       SELECT DISTINCT to_date(pay_date, 'MM/DD/YYYY') AS d
       FROM accounting.payroll_journal_headers
       WHERE kind <> 'allocation'
       ORDER BY d DESC
       LIMIT $1
     )
     SELECT h.id, h.entity, h.pay_date, h.pay_group, h.period_start, h.period_end, h.status,
            h.total_debits, h.total_credits, h.variance, h.row_count, h.source_snapshot_hash,
            h.qb_entry_id, h.qb_doc_number, h.kind, h.period_segment,
            to_char(h.txn_date,'YYYY-MM-DD') AS txn_date,
            (SELECT count(*) FROM accounting.payroll_journal_headers s
              WHERE s.entity = h.entity AND s.pay_date = h.pay_date
                AND s.pay_group = h.pay_group AND s.kind <> 'allocation')::text AS piece_count
     FROM accounting.payroll_journal_headers h
     WHERE to_date(h.pay_date, 'MM/DD/YYYY') IN (SELECT d FROM recent)
       AND h.kind <> 'allocation'
     ORDER BY to_date(h.pay_date, 'MM/DD/YYYY') DESC, h.entity, h.pay_group, h.period_segment`,
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
