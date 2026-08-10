/** READ-ONLY: hunt for any payroll-ish table in any schema on our RDS. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../src/lib/rds-ssl';
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const db = await pool.query(`SELECT current_database() db, current_user usr`);
    console.log('Connected:', JSON.stringify(db.rows[0]));
    const t = await pool.query(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_name ILIKE '%payroll%' OR table_name ILIKE '%pay_history%' ORDER BY 1,2`,
    );
    console.log(`\nTables matching payroll: ${t.rowCount}`);
    for (const r of t.rows) console.log(`   ${r.table_schema}.${r.table_name}`);
    const s = await pool.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' ORDER BY 1`,
    );
    console.log('\nSchemas visible:', s.rows.map((r) => r.schema_name).join(', '));
    const src = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='source' ORDER BY 1`,
    );
    console.log('source.* tables:', src.rows.map((r) => r.table_name).join(', ') || '(none)');
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
