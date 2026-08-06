/**
 * READ-ONLY: per-draft debit/credit balance across all prod drafts.
 * Confirms Barbara item (c) end-to-end — the COMPANY LOAN mapping should have
 * cleared the FL ~$250 / TN ~$1,391 imbalances. No writes.
 *   npx tsx scripts/payroll/probe-draft-balance.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const connectionString = process.env.RDS_DATABASE_URL;
if (!connectionString) throw new Error('RDS_DATABASE_URL not set');

async function main(): Promise<void> {
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  const rows = await pool.query<{ entity: string; pay_date: string; diff: string }>(
    `SELECT h.entity, h.pay_date, sum(CASE WHEN l.posting_type = 'Debit' THEN l.amount ELSE -l.amount END)::text AS diff
     FROM accounting.payroll_journal_headers h
     JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
     GROUP BY h.id, h.entity, h.pay_date
     HAVING sum(CASE WHEN l.posting_type = 'Debit' THEN l.amount ELSE -l.amount END) <> 0
     ORDER BY abs(sum(CASE WHEN l.posting_type = 'Debit' THEN l.amount ELSE -l.amount END)) DESC`,
  );
  console.log(`\n=== UNBALANCED drafts: ${rows.rowCount} ===`);
  for (const r of rows.rows) console.log(`  ${r.entity}  ${r.pay_date}  diff=${r.diff}`);

  const totals = await pool.query<{ entity: string; n: string }>(
    `SELECT entity, count(*)::text AS n FROM accounting.payroll_journal_headers GROUP BY 1 ORDER BY 1`,
  );
  console.log(`\n=== total drafts per entity ===`);
  for (const r of totals.rows) console.log(`  ${r.entity}  ${r.n}`);

  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
