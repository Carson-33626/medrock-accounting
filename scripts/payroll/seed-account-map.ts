/**
 * Payroll account-map seeder CLI.
 *   Preview (default, no writes): npx tsx scripts/payroll/seed-account-map.ts
 *   Apply (idempotent upsert):    npx tsx scripts/payroll/seed-account-map.ts --apply
 *
 * Loads .env.local for RDS (RDS_DATABASE_URL). Does NOT decrypt anything —
 * account-map rules are entity/column/cost_center -> GL account rules and
 * carry no employee PII.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import type { AccountMapRule, Entity } from '../../src/lib/payroll/types';
import { POSTABLE_ENTITIES } from '../../src/lib/payroll/entity';
import { buildSeedAccountMap } from './account-map-seed-data';

function printPreview(entity: Entity, rules: AccountMapRule[]): void {
  console.log(`\n================ ${entity} (${rules.length} rules) ================`);
  const byColumn = new Map<string, AccountMapRule[]>();
  for (const rule of rules) {
    const list = byColumn.get(rule.adpColumn) ?? [];
    list.push(rule);
    byColumn.set(rule.adpColumn, list);
  }
  for (const column of [...byColumn.keys()].sort()) {
    console.log(`  ${column}`);
    const list = [...(byColumn.get(column) ?? [])].sort(
      (a, b) => a.costCenter.localeCompare(b.costCenter) || a.postingType.localeCompare(b.postingType),
    );
    for (const rule of list) {
      const bucket = rule.creditBucket ? ` (${rule.creditBucket})` : '';
      const cogs = rule.isCogs ? ' [COGS]' : '';
      console.log(`    ${rule.costCenter.padEnd(6)} -> ${rule.postingType.padEnd(6)} ${rule.accountName}${bucket}${cogs}`);
    }
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  let totalRules = 0;
  for (const entity of POSTABLE_ENTITIES) {
    const rules = buildSeedAccountMap(entity);
    totalRules += rules.length;
    printPreview(entity, rules);
  }
  console.log(`\nTOTAL rules across FL/TN/TX: ${totalRules}`);

  if (!apply) {
    console.log('\nPreview only — no DB writes. Pass --apply to upsert into accounting.payroll_account_map.');
    return;
  }

  const { upsertAccountRule } = await import('../../src/lib/payroll/store');
  const { getRdsPool } = await import('../../src/lib/rds');
  console.log('\n--apply passed — upserting...');
  for (const entity of POSTABLE_ENTITIES) {
    const rules = buildSeedAccountMap(entity);
    let count = 0;
    for (const rule of rules) {
      await upsertAccountRule(rule);
      count++;
    }
    console.log(`${entity}: upserted ${count} rules`);
  }
  await getRdsPool().end();
}

void main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
