/** READ-ONLY: 401K rule shapes, one summary line per (column, cc-kind). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const r = await getRdsPool().query<{ adp_column: string; cost_center: string; posting_type: string; account_name: string; credit_bucket: string | null; memo: string | null; entities: string }>(
    `SELECT adp_column, cost_center, posting_type, account_name, credit_bucket, memo,
            string_agg(DISTINCT entity, ',') AS entities
       FROM accounting.payroll_account_map
      WHERE active AND adp_column ILIKE '%401K%'
      GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, 3`,
  );
  let last = '';
  for (const x of r.rows) {
    if (x.adp_column !== last) { console.log(`\n"${x.adp_column}"`); last = x.adp_column; }
    console.log(`  cc=${x.cost_center} ${x.posting_type} -> ${x.account_name} bucket=${x.credit_bucket} memo=${x.memo} [${x.entities}]`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
