/** READ-ONLY: does FL 07/17 have BOTH Admin + Accounting memo lines in ONE header? */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
for (const f of ['.env.local', '.env.vercel']) {
  try {
    const t = readFileSync(resolve(__dirname, '..', '..', f), 'utf-8');
    for (const line of t.split(/\r?\n/)) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  } catch { /* optional */ }
}
async function main(): Promise<void> {
  const { getRdsPool } = await import('../../src/lib/rds');
  const r = await getRdsPool().query(
    `SELECT l.header_id, h.pay_group, l.posting_type, l.memo, l.amount, l.origin
     FROM accounting.payroll_journal_lines l JOIN accounting.payroll_journal_headers h ON h.id=l.header_id
     WHERE h.entity='MedRock FL' AND h.pay_date='07/17/2026' AND l.account_name ILIKE '%Administrative Wages%'
     ORDER BY l.header_id, l.memo`,
  );
  console.log('FL 07/17 Administrative Wages lines:');
  for (const x of r.rows) console.log(x);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
