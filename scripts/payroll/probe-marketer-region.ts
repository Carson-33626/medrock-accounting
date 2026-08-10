/**
 * READ-ONLY: is a marketer's REGION recoverable from ADP plaintext columns?
 * Amy's manual JE splits Marketing Wages by QB Department (Miami/Tampa/Dallas/AZ region…),
 * but that per-marketer→region assignment was her worksheet knowledge, not in the JE.
 * ADP home_department is just 'MARKET-Marketing' for every marketer. This probe dumps the
 * plaintext column vocabulary and, for MARKET employees across ALL history, the distribution
 * of every plausibly-geographic plaintext column (location, etc.) by pay_group — so we can see
 * if `location` (or any other column) aligns with Amy's regions. Also lists recent FULL pay
 * dates (headcount per pay_date) to pick a representative period for the dry-run.
 * Prints ONLY position_id + org/geo plaintext values. NEVER decrypts; never prints names.
 *   npx tsx scripts/payroll/probe-marketer-region.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const PII = new Set(['name', 'sensitive_encrypted', 'id']);

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='source' AND table_name='payroll_history' ORDER BY ordinal_position`);
    const names = cols.rows.map((r) => r.column_name);

    // Recent pay dates with headcount, to spot FULL runs vs off-cycle corrections.
    const dates = await pool.query<{ d: string; pg: string; rows: string; emps: string }>(
      `SELECT pay_date d, COALESCE(pay_group,'(null)') pg, count(*)::text rows, count(DISTINCT position_id)::text emps
       FROM source.payroll_history
       GROUP BY pay_date, pay_group
       ORDER BY to_date(pay_date,'MM/DD/YYYY') DESC, pay_group
       LIMIT 40`);
    console.log('=== recent pay_date × pay_group (rows / distinct employees) ===');
    for (const x of dates.rows) console.log(`  ${x.d}  ${x.pg.padEnd(6)} rows:${x.rows.padStart(4)}  emps:${x.emps}`);

    // MARKET-employee distribution of each plaintext column across ALL history (region is stable per position).
    const candidateCols = names.filter(
      (n) => !PII.has(n) && !['pay_date', 'pay_num', 'row_key', 'updated_at', 'position_id', 'period_start_date', 'period_end_date'].includes(n),
    );
    console.log('\n=== MARKET-employee distribution by plaintext column (ALL history) ===');
    for (const col of candidateCols) {
      const r = await pool.query<{ pg: string; v: string; emps: string }>(
        `SELECT pay_group pg, COALESCE(${col}::text,'(null)') v, count(DISTINCT position_id)::text emps
         FROM source.payroll_history
         WHERE home_department ILIKE 'MARKET%'
         GROUP BY 1,2 ORDER BY 1, count(DISTINCT position_id) DESC`);
      if (r.rows.length === 0) continue;
      const byPg = new Map<string, number>();
      for (const x of r.rows) byPg.set(x.pg, (byPg.get(x.pg) ?? 0) + 1);
      const varies = [...byPg.values()].some((n) => n > 1);
      console.log(`\n  --- ${col} ${varies ? '⭐ VARIES among marketers' : '(uniform)'} ---`);
      for (const x of r.rows) console.log(`    ${x.pg} / ${x.v}: ${x.emps}`);
    }

    const head = await pool.query<{ pg: string; emps: string }>(
      `SELECT pay_group pg, count(DISTINCT position_id)::text emps FROM source.payroll_history
       WHERE home_department ILIKE 'MARKET%' GROUP BY 1 ORDER BY 1`);
    console.log('\n=== MARKET headcount per pay_group (all history) ===');
    for (const x of head.rows) console.log(`  ${x.pg}: ${x.emps}`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
