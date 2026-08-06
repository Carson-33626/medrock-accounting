/**
 * READ-ONLY probe: quantify what a 2026 bulk regenerate (build-range --apply) would affect.
 * Counts 2026 payroll_journal_headers by status, and how many manual / inter_entity lines
 * live on NON-posted 2026 headers (those are the lines saveDraft would DELETE on rebuild).
 * No writes. Untracked scratch script — do not commit.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const pool = getRdsPool();

  const byStatus = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*) AS n
       FROM accounting.payroll_journal_headers
      WHERE pay_date LIKE '%/2026'
      GROUP BY status ORDER BY status`,
  );
  console.log('=== 2026 headers by status ===');
  for (const r of byStatus.rows) console.log(`  ${r.status.padEnd(14)} ${r.n}`);

  const manual = await pool.query<{ origin: string; lines: string; headers: string; dollars: string }>(
    `SELECT l.origin,
            COUNT(*) AS lines,
            COUNT(DISTINCT h.id) AS headers,
            COALESCE(SUM(ABS(l.amount)),0)::text AS dollars
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.pay_date LIKE '%/2026'
        AND h.status <> 'posted'
        AND l.origin <> 'generated'
      GROUP BY l.origin ORDER BY l.origin`,
  );
  console.log('\n=== NON-posted 2026 manual/inter_entity lines that a regenerate WOULD DELETE ===');
  if (manual.rows.length === 0) console.log('  none — no manual lines on non-posted 2026 drafts');
  for (const r of manual.rows) {
    console.log(`  ${r.origin.padEnd(13)} lines=${r.lines}  on ${r.headers} drafts  |$|=${Number(r.dollars).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`);
  }

  const detail = await pool.query<{ entity: string; pay_date: string; account_name: string; memo: string; posting_type: string; amount: string; origin: string }>(
    `SELECT h.entity, h.pay_date, l.account_name, l.memo, l.posting_type, l.amount::text AS amount, l.origin
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.pay_date LIKE '%/2026' AND h.status <> 'posted' AND l.origin <> 'generated'
      ORDER BY h.entity, h.pay_date`,
  );
  console.log('\n=== RESTORE RECORD: the exact manual lines a regenerate will delete ===');
  for (const r of detail.rows) {
    console.log(`  ${r.entity} ${r.pay_date} | ${r.posting_type} ${Number(r.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} | ${r.account_name} | memo="${r.memo}" | origin=${r.origin}`);
  }

  const posted = await pool.query<{ origin: string; lines: string }>(
    `SELECT l.origin, COUNT(*) AS lines
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.pay_date LIKE '%/2026' AND h.status = 'posted' AND l.origin <> 'generated'
      GROUP BY l.origin ORDER BY l.origin`,
  );
  console.log('\n=== POSTED 2026 manual lines (PROTECTED — regenerate skips posted headers) ===');
  if (posted.rows.length === 0) console.log('  none');
  for (const r of posted.rows) console.log(`  ${r.origin.padEnd(13)} lines=${r.lines}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
