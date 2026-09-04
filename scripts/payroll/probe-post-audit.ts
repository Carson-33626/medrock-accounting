/** READ-ONLY: recent post attempts + outcomes from payroll_post_audit. Untracked scratch. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const r = await getRdsPool().query<{ id: number; created_at: string; header_id: number; mode: string; entity: string; qb_doc_number: string | null; outcome: string; response_status: string | null; reason: string | null; body: string | null }>(
    `SELECT id, created_at::text, header_id, mode, entity, qb_doc_number, outcome,
            response_status::text AS response_status, reason, LEFT(response_body::text, 500) AS body
       FROM accounting.payroll_post_audit
      ORDER BY id DESC LIMIT 25`,
  );
  console.log(`latest ${r.rows.length} audit rows:`);
  for (const x of r.rows) {
    console.log(`\n#${x.id} ${x.created_at} | header ${x.header_id} | ${x.entity} | mode=${x.mode} outcome=${x.outcome} status=${x.response_status}`);
    console.log(`  doc=${x.qb_doc_number} reason=${x.reason}`);
    if (x.outcome !== 'success' && x.body) console.log(`  body: ${x.body}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
