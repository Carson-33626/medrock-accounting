/**
 * READ-ONLY: why does opening the 07/07 MRTN "Anytime" run flag every column as unmapped?
 * Decrypts the off-cycle row, lists its non-zero columns + home_department/cost_center,
 * then checks each column against the MedRock TN account map. No writes.
 *   npx tsx scripts/payroll/probe-anytime-columns.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { costCenterFor } from '../../src/lib/payroll/cost-center';
import type { SensitiveRow } from '../../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface SrcRow {
  position_id: string;
  name: string;
  home_department: string | null;
  pay_group: string;
  sensitive_encrypted: string;
}
interface AcctRule {
  adp_column: string;
  cost_center: string;
  posting_type: string;
  account_name: string;
  active: boolean;
}

async function dump(pool: Pool, payDate: string, payGroup: string, entity: string): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');

  const { rows } = await pool.query<SrcRow>(
    `SELECT position_id, name, home_department, pay_group, sensitive_encrypted
     FROM source.payroll_history WHERE pay_date = $1 AND pay_group = $2`,
    [payDate, payGroup],
  );
  console.log(`\n===== ${payDate} ${payGroup} (${entity}) — ${rows.length} source row(s) =====`);

  const { rows: acct } = await pool.query<AcctRule>(
    `SELECT adp_column, cost_center, posting_type, account_name, active
     FROM accounting.payroll_account_map WHERE entity = $1`,
    [entity],
  );
  const activeCols = new Set(acct.filter((a) => a.active).map((a) => a.adp_column));
  console.log(`account map for ${entity}: ${acct.length} rules, ${activeCols.size} distinct active columns`);

  for (const r of rows) {
    const cc = costCenterFor(r.home_department ?? '');
    console.log(`\n  ${r.name} (pos ${r.position_id}) home_department=${JSON.stringify(r.home_department)} -> cost_center=${cc}`);
    const sensitive: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    const valueCols = Object.entries(sensitive).filter(([, v]) => typeof v === 'number' && v !== 0) as Array<[string, number]>;
    console.log(`  non-zero numeric columns: ${valueCols.length}`);
    for (const [col, val] of valueCols) {
      const colRules = acct.filter((a) => a.active && a.adp_column === col);
      const ccMatch = colRules.filter((a) => a.cost_center === cc || a.cost_center === '*');
      const flag = colRules.length === 0 ? 'NO COLUMN RULE' : ccMatch.length === 0 ? `col exists but only cc=[${[...new Set(colRules.map((a) => a.cost_center))].join(',')}]` : 'OK';
      console.log(`    ${flag.padEnd(28)} ${col} = ${val}`);
    }
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    await dump(pool, '07/07/2026', 'MRTN', 'MedRock TN');
    await dump(pool, '07/02/2026', 'MRFL', 'MedRock FL');
    // one regular row for contrast
    await dump(pool, '07/01/2026', 'MRTN', 'MedRock TN');
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
