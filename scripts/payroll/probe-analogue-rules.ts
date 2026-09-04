/** READ-ONLY: existing rule shapes for the analogues of the 18 unmapped history columns. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const r = await getRdsPool().query<{ entity: string; adp_column: string; cost_center: string; account_name: string; posting_type: string; credit_bucket: string | null; is_cogs: boolean; memo: string | null }>(
    `SELECT entity, adp_column, cost_center, account_name, posting_type, credit_bucket, is_cogs, memo
       FROM accounting.payroll_account_map
      WHERE active AND (
        adp_column ILIKE '%401K%' OR adp_column ILIKE '%UNEMPLOYMENT%'
        OR adp_column ILIKE '%REIMBURSEMENT%' OR adp_column ILIKE '%COMMISSION%'
      )
      ORDER BY adp_column, entity, cost_center, posting_type`,
  );
  let lastCol = '';
  for (const x of r.rows) {
    if (x.adp_column !== lastCol) { console.log(`\n"${x.adp_column}"`); lastCol = x.adp_column; }
    console.log(`  ${x.entity} cc=${x.cost_center} ${x.posting_type} -> ${x.account_name} bucket=${x.credit_bucket} cogs=${x.is_cogs} memo=${x.memo}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
