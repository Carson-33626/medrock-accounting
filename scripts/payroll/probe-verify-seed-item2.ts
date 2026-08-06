/** READ-ONLY: verify #2 seed landed (MEDICAL-ER per-dept memo rules) + assess rebuild risk. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
for (const f of ['.env.local', '.env.vercel']) {
  try { const t = readFileSync(resolve(__dirname, '..', '..', f), 'utf-8');
    for (const line of t.split(/\r?\n/)) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  } catch { /* optional */ }
}
async function main(): Promise<void> {
  const { getRdsPool } = await import('../../src/lib/rds');
  const pool = getRdsPool();

  const med = await pool.query(
    `SELECT entity, count(*) FILTER (WHERE posting_type='Debit' AND cost_center <> '*') AS per_dept_debits,
            count(*) FILTER (WHERE posting_type='Debit' AND cost_center = '*') AS star_debit,
            count(*) FILTER (WHERE posting_type='Credit') AS credits,
            count(*) FILTER (WHERE memo LIKE 'ER Medical -%') AS memo_rows
     FROM accounting.payroll_account_map WHERE adp_column='MEDICAL - ER' AND active GROUP BY entity ORDER BY entity`);
  console.log('=== MEDICAL - ER rules per entity (expect 9 per-dept debits, 1 * debit, 1 * credit, 9 memo rows) ===');
  for (const r of med.rows) console.log(r);

  const manual = await pool.query(
    `SELECT count(DISTINCT header_id) AS drafts_with_manual_lines, count(*) AS manual_lines
     FROM accounting.payroll_journal_lines WHERE origin <> 'generated'`);
  console.log('\n=== rebuild-wipe risk: drafts with non-generated (manual/inter_entity) lines ===');
  console.log(manual.rows[0]);

  const posted = await pool.query(
    `SELECT count(*) AS posted_headers FROM accounting.payroll_journal_headers WHERE status='posted'`);
  console.log('\n=== posted headers (must never be rebuilt; saveDraft guards them anyway) ===');
  console.log(posted.rows[0]);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
