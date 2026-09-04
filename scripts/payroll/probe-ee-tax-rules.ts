/** READ-ONLY: how are employee-side state income tax columns mapped? Untracked scratch. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const r = await getRdsPool().query<{ entity: string; adp_column: string; cost_center: string; account_name: string; posting_type: string; credit_bucket: string | null; memo: string | null; active: boolean }>(
    `SELECT entity, adp_column, cost_center, account_name, posting_type, credit_bucket, memo, active
       FROM accounting.payroll_account_map
      WHERE (adp_column ILIKE '%INCOME TAX%' OR adp_column ILIKE '%STATE%EE%' OR adp_column ILIKE '%- EE%TAX%')
      ORDER BY adp_column, entity`,
  );
  console.log(`EE income-tax-ish rules: ${r.rows.length}`);
  for (const x of r.rows) {
    console.log(`  ${x.active ? 'ACTIVE ' : 'inactive'} ${x.entity} | "${x.adp_column}" cc=${x.cost_center} ${x.posting_type} -> ${x.account_name} bucket=${x.credit_bucket} memo=${x.memo}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
