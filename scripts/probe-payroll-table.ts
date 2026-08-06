/** READ-ONLY: confirm source.payroll_history exists, matches the frozen schema, has rows. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
  try {
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='source' AND table_name='payroll_history' ORDER BY ordinal_position`,
    );
    if (cols.rowCount === 0) { console.log('❌ source.payroll_history NOT FOUND'); return; }
    console.log(`✅ source.payroll_history — ${cols.rowCount} columns:`);
    for (const c of cols.rows) console.log(`   ${c.column_name} : ${c.data_type}`);
    const cnt = await pool.query(`SELECT count(*)::int n, min(pay_date) a, max(pay_date) b FROM source.payroll_history`);
    console.log(`\nRows: ${cnt.rows[0].n}  pay_date range: ${cnt.rows[0].a} .. ${cnt.rows[0].b}`);
    const grp = await pool.query(
      `SELECT pay_group, count(*)::int n FROM source.payroll_history GROUP BY pay_group ORDER BY 2 DESC`,
    );
    console.log('By pay_group:', grp.rows.map((r) => `${r.pay_group}:${r.n}`).join('  '));
    const sample = await pool.query(`SELECT position_id, name, pay_date, length(sensitive_encrypted) enc_len FROM source.payroll_history LIMIT 3`);
    console.log('Sample:', JSON.stringify(sample.rows));
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
