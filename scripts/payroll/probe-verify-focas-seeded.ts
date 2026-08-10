/**
 * READ-ONLY re-verification after FOCAS was seeded (332 account-map rules) and its QuickBooks COA
 * was populated. Three questions:
 *   1. Do the now-real FOCAS JE lines carry any department / class at all? (If dept+class are
 *      always null, no FOCAS payroll dollar can be Allocate-flagged, whatever QB now offers.)
 *   2. Did FOCAS get the child-support / garnishment rules, and to which accounts?
 *   3. What do the FOCAS drafts actually contain, dollar for dollar?
 *   npx tsx scripts/payroll/probe-verify-focas-seeded.ts
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

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const dims = await pool.query<{ dept: string; cls: string; n: string; amt: string }>(
      `SELECT coalesce(l.department_name,'(null)') AS dept, coalesce(l.class_name,'(null)') AS cls,
              count(*)::text AS n, sum(l.amount)::text AS amt
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
       WHERE h.entity = 'FOCAS' GROUP BY 1,2 ORDER BY 1,2`,
    );
    console.log('-- every FOCAS JE line, by department x class --');
    for (const r of dims.rows) console.log(`  dept=${r.dept.padEnd(16)} class=${r.cls.padEnd(16)} lines=${String(r.n).padStart(4)} ${money(Number(r.amt))}`);

    const draft = await pool.query<{ pay_date: string; posting_type: string; account_name: string; memo: string | null; amt: string; n: string }>(
      `SELECT h.pay_date, l.posting_type, l.account_name, l.memo, sum(l.amount)::text AS amt, count(*)::text AS n
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
       WHERE h.entity = 'FOCAS' AND h.pay_date = '04/10/2026'
       GROUP BY 1,2,3,4 ORDER BY 2 DESC, 3`,
    );
    console.log('\n-- FOCAS 04/10/2026 drafts (both pieces), by line --');
    for (const r of draft.rows) console.log(`  ${r.posting_type.padEnd(6)} ${money(Number(r.amt)).padStart(12)} ${r.account_name.padEnd(46)} memo=${JSON.stringify(r.memo)}`);

    const garn = await pool.query<{ entity: string; adp_column: string; cost_center: string; account_name: string; posting_type: string; memo: string | null }>(
      `SELECT entity, adp_column, cost_center, account_name, posting_type, memo
       FROM accounting.payroll_account_map
       WHERE adp_column IN ('CHILD PAYMENTS','CHILD PAYMENTS - ER','GARNISH','BKWITHHOLD')
       ORDER BY adp_column, entity, posting_type`,
    );
    console.log(`\n-- child-support / garnishment account-map rules, all entities: ${garn.rows.length} --`);
    for (const r of garn.rows) {
      console.log(`  ${r.adp_column.padEnd(22)} ${r.entity.padEnd(14)} cc=${r.cost_center.padEnd(4)} ${r.posting_type.padEnd(6)} ${r.account_name.padEnd(40)} memo=${JSON.stringify(r.memo)}`);
    }

    // Does FOCAS payroll data even carry these columns?
    const cols = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM source.payroll_history WHERE pay_group = 'FOCS'`,
    );
    console.log(`\n  FOCS source rows (all time): ${cols.rows[0].n}`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
