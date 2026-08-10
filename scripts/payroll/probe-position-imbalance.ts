/**
 * READ-ONLY: dump one employee's columns and how each resolves, to name the exact column behind
 * a run's variance.
 *
 * MedRock FL carries a variance of EXACTLY $2.00 on nine 2026 pay dates, and the per-employee
 * pass narrowed 04/10/2026 to a single position in SHIP-Shipping. This shows that position's
 * every non-zero column across a date range with its resolved debit/credit targets, so the
 * offending column — and whether it is the same one every period — is visible directly.
 *
 * Prints position id, columns and dollars. No names.
 *   npx tsx scripts/payroll/probe-position-imbalance.ts 000155 "MedRock FL"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import { resolveLine } from '../../src/lib/payroll/mapping';
import type { AccountMapRule, EmployeeMapRule, PayrollRow, SensitiveRow } from '../../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const PLAINTEXT_COLS = [
  'position_id', 'name', 'status', 'worker_classification', 'home_department', 'location', 'pay_date',
  'pay_num', 'pay_frequency', 'pay_group', 'pay_type', 'period_start_date', 'period_end_date',
  'processed_as', 'rate_type', 'sui_sdi_tax_code', 'row_key', 'updated_at',
] as const;

const isTaxableBase = (col: string): boolean => /TAXABLE\s*$/.test(col.trim());
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const round2 = (n: number): number => Math.round(n * 100) / 100;

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const wantPos = process.argv[2] ?? '000155';
  const wantEntity = process.argv[3] ?? 'MedRock FL';

  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL, max: 1,
    ssl: RDS_SSL, connectionTimeoutMillis: 30_000,
  });

  try {
    const { rows: raw } = await pool.query<Record<string, string>>(
      `SELECT ${PLAINTEXT_COLS.join(', ')}, sensitive_encrypted
         FROM source.payroll_history
        WHERE position_id = $1 AND to_date(pay_date,'MM/DD/YYYY') BETWEEN '2026-01-01' AND '2026-12-31'
        ORDER BY to_date(pay_date,'MM/DD/YYYY')`,
      [wantPos],
    );

    const { rows: acct } = await pool.query<{
      entity: string; adp_column: string; cost_center: string; account_name: string;
      posting_type: string; is_cogs: boolean; credit_bucket: string | null; memo: string | null; active: boolean;
    }>(`SELECT entity, adp_column, cost_center, account_name, posting_type, is_cogs, credit_bucket, memo, active
          FROM accounting.payroll_account_map WHERE entity = $1 AND active`, [wantEntity]);
    const accountMap: AccountMapRule[] = acct.map((a) => ({
      entity: a.entity as AccountMapRule['entity'], adpColumn: a.adp_column, costCenter: a.cost_center,
      accountName: a.account_name, postingType: a.posting_type as AccountMapRule['postingType'],
      isCogs: a.is_cogs, creditBucket: a.credit_bucket as AccountMapRule['creditBucket'],
      active: a.active, memo: a.memo,
    }));
    const employeeMap: EmployeeMapRule[] = [];

    console.log(`\nposition ${wantPos} — ${raw.length} pay date(s) in 2026\n`);

    for (const r of raw) {
      if (entityForPayGroup(r.pay_group) !== wantEntity) continue;
      const base: Record<string, string> = {};
      for (const c of PLAINTEXT_COLS) base[c] = r[c] ?? '';
      const sensitive: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
      const row = { ...(base as unknown as Omit<PayrollRow, 'sensitive'>), sensitive } as PayrollRow;

      let d = 0;
      let c = 0;
      const detail: string[] = [];
      for (const [col, val] of Object.entries(sensitive)) {
        if (typeof val !== 'number' || val === 0) continue;
        if (isTaxableBase(col)) continue;
        const res = resolveLine(row, col, accountMap, employeeMap);
        if ('unmapped' in res) { detail.push(`      UNMAPPED  ${money(val).padStart(12)}  ${col}`); continue; }
        for (const t of res.targets) {
          if (t.postingType === 'Debit') d += val; else c += val;
          detail.push(`      ${t.postingType.padEnd(6)}    ${money(val).padStart(12)}  ${col.padEnd(42)} -> ${t.accountName}`);
        }
      }
      const delta = round2(d - c);
      console.log(`  ${r.pay_date}  dept=${r.home_department}  D=${money(round2(d))} C=${money(round2(c))}  NET=${money(delta)}${delta !== 0 ? '   <-- IMBALANCED' : ''}`);
      if (delta !== 0) for (const line of detail) console.log(line);
    }
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
