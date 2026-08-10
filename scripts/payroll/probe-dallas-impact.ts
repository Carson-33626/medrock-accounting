/** READ-ONLY: dollars carried by the unclassed Dallas-Region marketers on MedRock FL, and proof
 *  that an employee-map class is entity-scoped (so classing the FL row cannot touch TX rows). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import type { SensitiveRow } from '../../src/lib/payroll/types';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL, connectionTimeoutMillis: 30_000 });
  try {
    const targets = ['000198', '000760', '000801'];
    const already = ['000224', '000717'];
    const { rows } = await pool.query<{ position_id: string; name: string; pay_group: string; pay_date: string; sensitive_encrypted: string }>(
      `SELECT position_id, name, pay_group, pay_date, sensitive_encrypted FROM source.payroll_history
        WHERE position_id = ANY($1) AND pay_group = 'MRFL'`, [[...targets, ...already]]);
    const agg = new Map<string, { name: string; gross: number; dates: Set<string> }>();
    for (const r of rows) {
      const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
      const g = typeof s['GROSS PAY'] === 'number' ? (s['GROSS PAY'] as number) : 0;
      const cur = agg.get(r.position_id) ?? { name: r.name, gross: 0, dates: new Set<string>() };
      cur.gross += g; cur.dates.add(r.pay_date);
      agg.set(r.position_id, cur);
    }
    console.log('\n=== gross pay on the MedRock FL payroll ===');
    let gap = 0;
    for (const [pos, v] of [...agg].sort()) {
      const tag = targets.includes(pos) ? 'UNCLASSED (would move)' : 'already Allocate - TX';
      if (targets.includes(pos)) gap += v.gross;
      console.log(`  ${pos}  ${v.name.padEnd(30)} ${money(v.gross).padStart(13)}  ${v.dates.size} pay dates  ${tag}`);
    }
    console.log(`\n  TOTAL gross currently sitting in FL that would move to TX: ${money(gap)}`);

    const { rows: m } = await pool.query<{ entity: string; position_id: string; class_name: string | null }>(
      `SELECT entity, position_id, class_name FROM accounting.payroll_employee_map
        WHERE position_id = ANY($1) ORDER BY position_id, entity`, [[...targets, ...already]]);
    console.log('\n=== employee-map rows (note the ENTITY column — a class is entity-scoped) ===');
    for (const r of m) console.log(`  ${r.entity.padEnd(12)} ${r.position_id}  class=${r.class_name ?? '(none)'}`);
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
