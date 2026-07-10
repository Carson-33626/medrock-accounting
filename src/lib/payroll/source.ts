import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRdsPool } from '../rds';
import { decryptSensitive } from './crypto';
import { inRange } from './dates';
import type { PayrollRow, SensitiveRow } from './types';

const PLAINTEXT_COLS = [
  'position_id', 'name', 'status', 'worker_classification', 'home_department', 'location', 'pay_date',
  'pay_num', 'pay_frequency', 'pay_group', 'pay_type', 'period_start_date', 'period_end_date',
  'processed_as', 'rate_type', 'sui_sdi_tax_code', 'row_key', 'updated_at',
] as const;

export interface PayrollSource { fetchRange(startISO: string, endISO: string): Promise<PayrollRow[]>; }

function toRow(base: Record<string, string>, sensitive: SensitiveRow): PayrollRow {
  return { ...(base as unknown as Omit<PayrollRow, 'sensitive'>), sensitive };
}

export class FixturePayrollSource implements PayrollSource {
  async fetchRange(startISO: string, endISO: string): Promise<PayrollRow[]> {
    const dir = resolve(__dirname, 'fixtures');
    const key = readFileSync(resolve(dir, 'test-key.txt'), 'utf8').trim();
    const raw = JSON.parse(readFileSync(resolve(dir, 'payroll_history.fixture.json'), 'utf8')) as Array<Record<string, string>>;
    return raw
      .filter((r) => r.pay_date && inRange(r.pay_date, startISO, endISO))
      .map((r) => toRow(r, decryptSensitive(r.sensitive_encrypted, key)));
  }
}

export class RdsPayrollSource implements PayrollSource {
  constructor(private readonly keyB64: string) {}
  async fetchRange(startISO: string, endISO: string): Promise<PayrollRow[]> {
    const pool = getRdsPool();
    const cols = PLAINTEXT_COLS.join(', ');
    const res = await pool.query<Record<string, string>>(
      `SELECT ${cols}, sensitive_encrypted
       FROM source.payroll_history
       WHERE to_date(pay_date, 'MM/DD/YYYY') BETWEEN $1::date AND $2::date`,
      [startISO, endISO],
    );
    return res.rows.map((r) => {
      const enc = r.sensitive_encrypted;
      const base: Record<string, string> = {};
      for (const c of PLAINTEXT_COLS) base[c] = r[c] ?? '';
      return toRow(base, decryptSensitive(enc, this.keyB64));
    });
  }
}
