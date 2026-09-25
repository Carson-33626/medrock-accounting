/**
 * RDS persistence for the daily month-end allocation difference check (DS 2026-09-25 §3).
 * Settings (accounting.eom_diff_settings), run history (eom_diff_runs), and the stored
 * per-month/per-entity delta (eom_diff_checks). See scripts/migrations/create_eom_diff.sql.
 */
import { getRdsPool } from '../rds';
import { monthEndAdp, type Month } from './month';
import type { EomDiffSettings } from './eom-correction';
import type { JsonValue } from './store';
import type { Entity, JournalLine, PostingType } from './types';

const DEFAULT_SETTINGS: EomDiffSettings = { threshold: 1, enabled: true, checkFromMonth: '2026-03' };

interface SettingsRow { threshold: string; enabled: boolean; check_from_month: string }

function toSettings(r: SettingsRow): EomDiffSettings {
  return { threshold: Number(r.threshold), enabled: r.enabled, checkFromMonth: r.check_from_month };
}

export async function getSettings(): Promise<EomDiffSettings> {
  const { rows } = await getRdsPool().query<SettingsRow>(
    `SELECT threshold::text, enabled, check_from_month FROM accounting.eom_diff_settings WHERE id = 1`,
  );
  const row = rows[0];
  return row ? toSettings(row) : DEFAULT_SETTINGS;
}

export async function updateSettings(v: Partial<EomDiffSettings>, by: string | null): Promise<EomDiffSettings> {
  const sets: string[] = [];
  const params: Array<number | boolean | string | null> = [];
  if (v.threshold !== undefined) { params.push(v.threshold); sets.push(`threshold = $${params.length}`); }
  if (v.enabled !== undefined) { params.push(v.enabled); sets.push(`enabled = $${params.length}`); }
  if (v.checkFromMonth !== undefined) { params.push(v.checkFromMonth); sets.push(`check_from_month = $${params.length}`); }
  params.push(by);
  sets.push('updated_at = now()', `updated_by = $${params.length}`);

  const { rows } = await getRdsPool().query<SettingsRow>(
    `UPDATE accounting.eom_diff_settings SET ${sets.join(', ')} WHERE id = 1
     RETURNING threshold::text, enabled, check_from_month`,
    params,
  );
  return toSettings(rows[0]);
}

export interface EomDiffRun {
  id: number;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
}

interface RunRow { id: number; trigger: string; started_at: string; finished_at: string | null; ok: boolean | null; error: string | null }

function toRun(r: RunRow): EomDiffRun {
  return { id: Number(r.id), trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok, error: r.error };
}

export async function startRun(trigger: 'cron' | 'manual'): Promise<number> {
  const { rows } = await getRdsPool().query<{ id: number }>(
    `INSERT INTO accounting.eom_diff_runs (trigger) VALUES ($1) RETURNING id`,
    [trigger],
  );
  return Number(rows[0].id);
}

export async function finishRun(id: number, ok: boolean, error: string | null): Promise<void> {
  await getRdsPool().query(
    `UPDATE accounting.eom_diff_runs SET finished_at = now(), ok = $2, error = $3 WHERE id = $1`,
    [id, ok, error],
  );
}

export async function latestRun(): Promise<EomDiffRun | null> {
  const { rows } = await getRdsPool().query<RunRow>(
    `SELECT id, trigger,
            to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
            to_char(finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finished_at,
            ok, error
     FROM accounting.eom_diff_runs
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
  );
  const row = rows[0];
  return row ? toRun(row) : null;
}

export interface EomDiffCheck {
  month: string;
  entity: Entity;
  runId: number;
  checkedAt: string;
  deltaLines: JournalLine[];
  deltaDebits: number;
  error: string | null;
}

interface CheckRow {
  month: string;
  entity: Entity;
  run_id: number;
  checked_at: string;
  delta_lines: JsonValue;
  delta_debits: string;
  error: string | null;
}

const POSTING_TYPES: readonly PostingType[] = ['Debit', 'Credit'];

/** Narrow one jsonb array item to a JournalLine, filling the fields the check never stored
 *  (they carry no meaning for a delta; see the brief). Malformed items are dropped. */
function toJournalLine(item: JsonValue): JournalLine | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  const r: { [key: string]: JsonValue } = item;
  const postingType = r.postingType;
  const amount = r.amount;
  const accountName = r.accountName;
  const memo = r.memo;
  if (typeof postingType !== 'string' || !POSTING_TYPES.includes(postingType as PostingType)) return null;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (typeof accountName !== 'string') return null;
  if (memo !== undefined && typeof memo !== 'string') return null;
  return {
    postingType: postingType as PostingType,
    amount,
    accountName,
    memo: typeof memo === 'string' ? memo : '',
    departmentName: null,
    className: null,
    creditBucket: null,
    origin: 'inter_entity',
    sourceRowKeys: [],
  };
}

function toDeltaLines(value: JsonValue): JournalLine[] {
  if (!Array.isArray(value)) return [];
  const out: JournalLine[] = [];
  for (const item of value) {
    const line = toJournalLine(item);
    if (line) out.push(line);
  }
  return out;
}

function toCheck(r: CheckRow): EomDiffCheck {
  return {
    month: r.month,
    entity: r.entity,
    runId: Number(r.run_id),
    checkedAt: r.checked_at,
    deltaLines: toDeltaLines(r.delta_lines),
    deltaDebits: Number(r.delta_debits),
    error: r.error,
  };
}

export async function upsertCheck(c: {
  month: string; entity: Entity; runId: number; deltaLines: JournalLine[]; deltaDebits: number; error: string | null;
}): Promise<void> {
  await getRdsPool().query(
    `INSERT INTO accounting.eom_diff_checks (month, entity, run_id, delta_lines, delta_debits, error, checked_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (month, entity) DO UPDATE SET
       run_id = EXCLUDED.run_id, delta_lines = EXCLUDED.delta_lines, delta_debits = EXCLUDED.delta_debits,
       error = EXCLUDED.error, checked_at = now()`,
    [c.month, c.entity, c.runId, JSON.stringify(c.deltaLines), c.deltaDebits, c.error],
  );
}

export async function listChecks(): Promise<EomDiffCheck[]> {
  const { rows } = await getRdsPool().query<CheckRow>(
    `SELECT month, entity, run_id, to_char(checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS checked_at,
            delta_lines, delta_debits::text, error
     FROM accounting.eom_diff_checks
     ORDER BY month, entity`,
  );
  return rows.map(toCheck);
}

/** Distinct 'YYYY-MM' of posted EOM parents (period_segment='') from fromMonth on, ascending. */
export async function listPostedParentMonths(fromMonth: string): Promise<string[]> {
  const { rows } = await getRdsPool().query<{ month: string }>(
    `SELECT DISTINCT to_char(to_date(pay_date,'MM/DD/YYYY'),'YYYY-MM') AS month
     FROM accounting.payroll_journal_headers
     WHERE kind = 'allocation' AND pay_group = 'EOM' AND period_segment = '' AND status = 'posted'
       AND to_char(to_date(pay_date,'MM/DD/YYYY'),'YYYY-MM') >= $1
     ORDER BY 1`,
    [fromMonth],
  );
  return rows.map((r) => r.month);
}

/** Posted EOM headers (parent + C-rows) for the month/entity, oldest correction first. */
export async function listPostedEomHeaderIds(m: Month, entity: Entity): Promise<number[]> {
  const { rows } = await getRdsPool().query<{ id: number }>(
    `SELECT id FROM accounting.payroll_journal_headers
     WHERE kind='allocation' AND pay_group='EOM' AND status='posted' AND pay_date = $1 AND entity = $2
     ORDER BY period_segment`,
    [monthEndAdp(m), entity],
  );
  return rows.map((r) => Number(r.id));
}
