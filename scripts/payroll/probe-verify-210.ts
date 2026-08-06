/** READ-ONLY: verify header 210 (FL 07/17) after rebuild — dept-split, ordering, no manual plug. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
for (const f of ['.env.local']) {
  try { const t = readFileSync(resolve(__dirname, '..', '..', f), 'utf-8');
    for (const line of t.split(/\r?\n/)) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  } catch { /* optional */ }
}
async function main(): Promise<void> {
  const { getRdsPool } = await import('../../src/lib/rds');
  const pool = getRdsPool();

  const h = await pool.query(
    `SELECT id, status, total_debits, total_credits, variance,
            (SELECT count(*) FROM accounting.payroll_journal_lines l WHERE l.header_id=h.id AND l.origin<>'generated') AS manual_lines
     FROM accounting.payroll_journal_headers h WHERE id=210`);
  console.log('=== header 210 ===');
  console.log(h.rows[0]);

  const accrued = await pool.query(
    `SELECT posting_type, memo, amount FROM accounting.payroll_journal_lines
     WHERE header_id=210 AND account_name ILIKE '%Accrued Payroll Liability%' ORDER BY memo`);
  console.log('\n=== Accrued Payroll Liability lines on 210 (expect per-department memos now) ===');
  for (const r of accrued.rows) console.log(r);

  const admin = await pool.query(
    `SELECT memo, amount FROM accounting.payroll_journal_lines
     WHERE header_id=210 AND account_name ILIKE '%Administrative Wages%' ORDER BY memo`);
  console.log('\n=== Administrative Wages lines on 210 (Admin + Accounting) ===');
  for (const r of admin.rows) console.log(r);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
