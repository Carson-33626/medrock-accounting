/**
 * Payroll employee-map seeder CLI (marketer -> region overlay).
 *   Preview (default, no writes): npx tsx scripts/payroll/seed-employee-map.ts
 *   Apply (idempotent upsert):    npx tsx scripts/payroll/seed-employee-map.ts --apply
 *
 * Loads .env.local for RDS (RDS_DATABASE_URL). Reads plaintext payroll_history columns only
 * (position_id, name, pay_group) to join against scripts/payroll/territory-snapshot.json --
 * see scripts/payroll/employee-map-seed-data.ts for the full derivation. Prints per-entity
 * positionId -> (Department, Class) plus the unmatched-marketer list; never prints dollar
 * amounts (this map carries no wage data at all).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import type { Entity, EmployeeMapRule } from '../../src/lib/payroll/types';
import { POSTABLE_ENTITIES } from '../../src/lib/payroll/entity';
import { buildMarketerEmployeeMap, lastUnmatchedMarketers } from './employee-map-seed-data';

function printPreview(entity: Entity, rules: EmployeeMapRule[]): void {
  console.log(`\n================ ${entity} (${rules.length} marketer rule(s)) ================`);
  const sorted = [...rules].sort((a, b) => a.positionId.localeCompare(b.positionId));
  for (const rule of sorted) {
    console.log(`  ${rule.positionId.padEnd(12)} -> Department: ${rule.departmentName ?? '(none)'}   Class: ${rule.className ?? '(none)'}`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const rules = await buildMarketerEmployeeMap();

  const byEntity = new Map<Entity, EmployeeMapRule[]>();
  for (const rule of rules) {
    const list = byEntity.get(rule.entity) ?? [];
    list.push(rule);
    byEntity.set(rule.entity, list);
  }

  let total = 0;
  for (const entity of POSTABLE_ENTITIES) {
    const list = byEntity.get(entity) ?? [];
    total += list.length;
    printPreview(entity, list);
  }

  console.log(`\nTOTAL marketer employee-map rules across FL/TN/TX: ${total}`);
  console.log(`UNMATCHED marketer names (no territory_mapping rep found): ${lastUnmatchedMarketers.length}`);
  for (const u of lastUnmatchedMarketers) console.log(`  [${u.payGroup}] ${u.name}  (sui=${u.sui})`);

  if (!apply) {
    console.log('\nPreview only — no DB writes. Pass --apply to upsert into accounting.payroll_employee_map.');
    const { getRdsPool } = await import('../../src/lib/rds');
    await getRdsPool().end();
    return;
  }

  const { upsertEmployeeRule } = await import('../../src/lib/payroll/store');
  const { getRdsPool } = await import('../../src/lib/rds');
  console.log('\n--apply passed — upserting...');
  for (const entity of POSTABLE_ENTITIES) {
    const list = byEntity.get(entity) ?? [];
    let count = 0;
    for (const rule of list) {
      await upsertEmployeeRule(rule);
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
