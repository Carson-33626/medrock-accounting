/** READ-ONLY: why is 'PA STATE - EE INCOME TAX' unmapped when PA rules existed before? Untracked scratch. */
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

  const rules = await pool.query<{ entity: string; adp_column: string; cost_center: string; account_name: string; posting_type: string; active: boolean; updated_at: string }>(
    `SELECT entity, adp_column, cost_center, account_name, posting_type, active, updated_at::text
       FROM accounting.payroll_account_map
      WHERE adp_column ILIKE '%PA %' OR adp_column ILIKE 'PA%' OR adp_column ILIKE '%PENN%'
      ORDER BY adp_column, entity, posting_type`,
  );
  console.log(`[1] account-map rules mentioning PA: ${rules.rows.length}`);
  for (const r of rules.rows) console.log(`    ${r.active ? 'ACTIVE ' : 'inactive'} ${r.entity} | col="${r.adp_column}" cc=${r.cost_center} ${r.posting_type} -> ${r.account_name} (upd ${r.updated_at.slice(0, 10)})`);

  const who = await pool.query<{ position_id: string; name: string; home_department: string; pay_group: string; pay_date: string }>(
    `SELECT DISTINCT position_id, name, home_department, pay_group, pay_date
       FROM source.payroll_history
      WHERE sui_sdi_tax_code ILIKE '%PA%' OR location ILIKE '%PA%' OR location ILIKE '%Penn%'
      ORDER BY pay_date DESC LIMIT 15`,
  );
  console.log(`\n[2] recent rows with PA tax code / location: ${who.rows.length}`);
  for (const r of who.rows) console.log(`    ${r.position_id} ${r.name} | ${r.home_department} | ${r.pay_group} | loc-based | paid ${r.pay_date}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
