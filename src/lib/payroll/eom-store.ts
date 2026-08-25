/** Persistence for month-end allocation runs: the pool/revenue snapshot per month
 *  (accounting.payroll_eom_runs) + header queries scoped to kind='allocation'. */
import { getRdsPool } from '../rds';
import { toHeader, type HeaderRow, type JsonValue, type PayrollHeader } from './store';
import { monthEndAdp, type Month } from './month';
import type { Entity } from './types';

export interface EomRun {
  month: string;
  pool: JsonValue;
  revenue: JsonValue;
  attention: JsonValue;
  generatedAt: string;
}

export async function saveEomRun(run: { month: string; pool: JsonValue; revenue: JsonValue; attention: JsonValue }): Promise<void> {
  await getRdsPool().query(
    `INSERT INTO accounting.payroll_eom_runs (month, pool, revenue, attention, generated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (month) DO UPDATE SET
       pool = EXCLUDED.pool, revenue = EXCLUDED.revenue, attention = EXCLUDED.attention, generated_at = now()`,
    [run.month, JSON.stringify(run.pool), JSON.stringify(run.revenue), JSON.stringify(run.attention)],
  );
}

interface EomRunRow { month: string; pool: JsonValue; revenue: JsonValue; attention: JsonValue; generated_at: string }

export async function getEomRun(month: string): Promise<EomRun | null> {
  const { rows } = await getRdsPool().query<EomRunRow>(
    `SELECT month, pool, revenue, attention, to_char(generated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS generated_at
     FROM accounting.payroll_eom_runs WHERE month = $1`,
    [month],
  );
  const r = rows[0];
  return r ? { month: r.month, pool: r.pool, revenue: r.revenue, attention: r.attention, generatedAt: r.generated_at } : null;
}

export async function listEomHeaders(m: Month): Promise<PayrollHeader[]> {
  const { rows } = await getRdsPool().query<HeaderRow>(
    `SELECT id, entity, pay_date, pay_group, period_start, period_end, status,
            total_debits, total_credits, variance, row_count, source_snapshot_hash,
            qb_entry_id, qb_doc_number, kind, period_segment, to_char(txn_date,'YYYY-MM-DD') AS txn_date
     FROM accounting.payroll_journal_headers
     WHERE pay_group = 'EOM' AND kind = 'allocation' AND pay_date = $1
     ORDER BY entity`,
    [monthEndAdp(m)],
  );
  return rows.map(toHeader);
}

/** POSTED CS-only catch-up entries for the month — pay_group 'CS ALLO' plus its top-up
 *  groups ('CS ALLO 2', ...). Their existence is the trigger for the hard rule: the full
 *  month-end excludes the Customer-Service pool slice for such a month (see
 *  cs-catchup.excludeCsLines) because those dollars are already allocated in QuickBooks. */
export async function listPostedCsAlloHeaders(m: Month): Promise<PayrollHeader[]> {
  const { rows } = await getRdsPool().query<HeaderRow>(
    `SELECT id, entity, pay_date, pay_group, period_start, period_end, status,
            total_debits, total_credits, variance, row_count, source_snapshot_hash,
            qb_entry_id, qb_doc_number, kind, period_segment, to_char(txn_date,'YYYY-MM-DD') AS txn_date
     FROM accounting.payroll_journal_headers
     WHERE pay_group LIKE 'CS ALLO%' AND kind = 'allocation' AND status = 'posted' AND pay_date = $1
     ORDER BY entity, pay_group`,
    [monthEndAdp(m)],
  );
  return rows.map(toHeader);
}

/** Regeneration replace-semantics: drop unposted drafts for entities the rebuild no
 *  longer produces. Posted headers are never deleted (lines cascade via FK). */
export async function deleteUnpostedEomHeaders(m: Month, keepEntities: Entity[]): Promise<number> {
  const { rowCount } = await getRdsPool().query(
    `DELETE FROM accounting.payroll_journal_headers
     WHERE pay_group = 'EOM' AND kind = 'allocation' AND pay_date = $1
       AND status <> 'posted' AND NOT (entity = ANY($2::text[]))`,
    [monthEndAdp(m), keepEntities],
  );
  return rowCount ?? 0;
}
