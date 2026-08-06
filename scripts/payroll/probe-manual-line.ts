/** READ-ONLY: identify the single non-generated JE line before any rebuild would overwrite it. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
for (const f of ['.env.local']) {
  try { const t = readFileSync(resolve(__dirname, '..', '..', f), 'utf-8');
    for (const line of t.split(/\r?\n/)) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  } catch { /* optional */ }
}
async function main(): Promise<void> {
  const { getRdsPool } = await import('../../src/lib/rds');
  const r = await getRdsPool().query(
    `SELECT h.id AS header_id, h.entity, h.pay_date, h.status, l.posting_type, l.account_name, l.memo, l.amount, l.origin
     FROM accounting.payroll_journal_lines l JOIN accounting.payroll_journal_headers h ON h.id=l.header_id
     WHERE l.origin <> 'generated'`);
  console.log('Non-generated JE line(s):');
  for (const x of r.rows) console.log(x);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
