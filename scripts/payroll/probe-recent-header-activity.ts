/** READ-ONLY: recently-touched headers + any approved/posted, to trace Barbara's clicks. */
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
  const recent = await pool.query<{ id: number; entity: string; pay_date: string; kind: string; status: string; updated_at: string }>(
    `SELECT id, entity, pay_date, kind, status, updated_at::text
       FROM accounting.payroll_journal_headers
      WHERE updated_at > now() - interval '36 hours' AND kind <> 'pay_date'
      ORDER BY updated_at DESC LIMIT 15`,
  );
  console.log('non-pay_date headers touched in the last 36h:');
  for (const x of recent.rows) console.log(`  #${x.id} ${x.entity} ${x.pay_date} ${x.kind} ${x.status} upd=${x.updated_at}`);

  const appr = await pool.query<{ id: number; entity: string; pay_date: string; kind: string; status: string; updated_at: string }>(
    `SELECT id, entity, pay_date, kind, status, updated_at::text
       FROM accounting.payroll_journal_headers
      WHERE status IN ('approved', 'posted') ORDER BY updated_at DESC LIMIT 15`,
  );
  console.log('\nall approved/posted headers:');
  for (const x of appr.rows) console.log(`  #${x.id} ${x.entity} ${x.pay_date} ${x.kind} ${x.status} upd=${x.updated_at}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
