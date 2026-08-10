/** READ-ONLY: who on MedRock TX carries the "Puerto Rico Region" QB department, and where does
 * it come from? Confirms the label is a marketer-region overlay (Remote -> Puerto Rico Region),
 * NOT an actual PR employee. No decrypt, plaintext columns only. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const pr = await pool.query(
      `SELECT pm.entity, pm.position_id, pm.department_name, pm.class_name, pm.active, pm.reviewed,
              ph.name, ph.home_department, ph.location, ph.status
       FROM accounting.payroll_employee_map pm
       LEFT JOIN LATERAL (
         SELECT name, home_department, location, status
         FROM source.payroll_history h
         WHERE h.position_id = pm.position_id
         ORDER BY h.pay_date DESC LIMIT 1
       ) ph ON true
       WHERE pm.department_name ILIKE 'Puerto Rico%'
       ORDER BY pm.entity, pm.position_id`);
    console.log(`=== employee_map rows with department 'Puerto Rico%' (${pr.rowCount}) ===`);
    for (const r of pr.rows) console.log(r);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
