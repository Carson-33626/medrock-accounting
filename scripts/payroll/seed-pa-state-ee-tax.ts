/**
 * Add 'PA STATE - EE INCOME TAX' to the account map — same shape as every other
 * '<STATE> STATE - EE INCOME TAX' rule (cc=* Credit -> Payroll Withholdings, bucket Taxes,
 * all 4 entities). First PA wages since the seed: Olymbia Lymberis (MRTN) 08/14/2026.
 *
 *   npx tsx scripts/payroll/seed-pa-state-ee-tax.ts --apply
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import type { Entity } from '../../src/lib/payroll/types';
import { upsertAccountRule } from '../../src/lib/payroll/store';

const apply = process.argv.includes('--apply');
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX', 'FOCAS'];

async function main(): Promise<void> {
  console.log(`mode=${apply ? 'APPLY' : 'PREVIEW'}`);
  for (const entity of ENTITIES) {
    if (!apply) { console.log(`  would upsert ${entity} | "PA STATE - EE INCOME TAX" cc=* Credit -> Payroll Withholdings bucket=Taxes`); continue; }
    const id = await upsertAccountRule({
      entity, adpColumn: 'PA STATE - EE INCOME TAX', costCenter: '*',
      accountName: 'Payroll Withholdings', postingType: 'Credit',
      isCogs: false, creditBucket: 'Taxes', active: true, memo: null,
    });
    console.log(`  upserted #${id} ${entity}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
