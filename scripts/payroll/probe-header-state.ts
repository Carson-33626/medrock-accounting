/**
 * READ-ONLY: inspect accounting.payroll_journal_headers to see what drafts actually
 * exist — pay dates, entities, statuses, row counts, totals, created/updated times.
 * No writes. Answers "were JEs destroyed or is the landing just showing sparse recent runs?"
 *   npx tsx scripts/payroll/probe-header-state.ts
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

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: RDS_SSL,
  });
  try {
    const total = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM accounting.payroll_journal_headers`,
    );
    console.log(`TOTAL headers: ${total.rows[0].n}`);

    const byDate = await pool.query<{
      pay_date: string;
      entity: string;
      pay_group: string;
      status: string;
      row_count: number;
      total_debits: string;
      lines: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT h.pay_date, h.entity, h.pay_group, h.status, h.row_count, h.total_debits,
              (SELECT count(*) FROM accounting.payroll_journal_lines l WHERE l.header_id = h.id) AS lines,
              to_char(h.created_at, 'YYYY-MM-DD HH24:MI') created_at,
              to_char(h.updated_at, 'YYYY-MM-DD HH24:MI') updated_at
       FROM accounting.payroll_journal_headers h
       ORDER BY to_date(h.pay_date,'MM/DD/YYYY') DESC, h.entity, h.pay_group`,
    );
    console.log(`\npay_date   entity        pay_group                rows  lines  debits        status         created           updated`);
    for (const r of byDate.rows) {
      console.log(
        `${r.pay_date}  ${r.entity.padEnd(12)}  ${(r.pay_group ?? '').padEnd(22)}  ${String(r.row_count).padStart(4)}  ${String(r.lines).padStart(5)}  ${String(r.total_debits).padStart(11)}  ${r.status.padEnd(13)}  ${r.created_at}  ${r.updated_at}`,
      );
    }

    // How many source rows exist per recent pay date, for comparison.
    const src = await pool.query<{ pay_date: string; pay_group: string; n: string }>(
      `SELECT pay_date, pay_group, count(*) n
       FROM source.payroll_history
       GROUP BY pay_date, pay_group
       ORDER BY to_date(pay_date,'MM/DD/YYYY') DESC, pay_group
       LIMIT 20`,
    );
    console.log(`\nsource.payroll_history row counts (most recent 20 date/group):`);
    for (const r of src.rows) console.log(`  ${r.pay_date}  ${(r.pay_group ?? '').padEnd(24)}  ${r.n} rows`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
