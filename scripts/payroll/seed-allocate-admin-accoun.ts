/**
 * Seed employee-map rows tagging ADMIN + ACCOUN staff with class 'Allocate - %' so their
 * expense lines enter the month-end allocation pool (split by Barbara's presence rule —
 * 1/3 each while all three entities have revenue). Carson's directive 2026-08-18.
 *
 * Roster from source.payroll_history 2026 (probe-alloc-roster.ts). FOCS positions are
 * deliberately excluded: EOM allocation is FL/TN/TX-only and FOCAS QB carries no
 * Allocate classes. Terminated/deceased staff ARE included — their Jan-May wages are
 * admin costs that must allocate when those months post.
 *
 *   Preview: npx tsx scripts/payroll/seed-allocate-admin-accoun.ts
 *   Apply:   npx tsx scripts/payroll/seed-allocate-admin-accoun.ts --apply
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import type { Entity } from '../../src/lib/payroll/types';
import { upsertEmployeeRule } from '../../src/lib/payroll/store';
import { getRdsPool } from '../../src/lib/rds';

const apply = process.argv.includes('--apply');

interface SeedRow { entity: Entity; positionId: string; who: string }
const ROWS: SeedRow[] = [
  { entity: 'MedRock FL', positionId: '000051', who: 'Wiley (ADMIN)' },
  { entity: 'MedRock FL', positionId: '000091', who: 'Legrand (ACCOUN)' },
  { entity: 'MedRock FL', positionId: '000102', who: 'Ahmed (ADMIN)' },
  { entity: 'MedRock FL', positionId: '000123', who: 'Carson (ADMIN)' },
  { entity: 'MedRock FL', positionId: '000155', who: 'Graulau-Lugo (ADMIN)' },
  { entity: 'MedRock FL', positionId: '000199', who: 'Newby (ACCOUN, deceased)' },
  { entity: 'MedRock FL', positionId: '000419', who: 'Utesch (ADMIN)' },
  { entity: 'MedRock FL', positionId: '000657', who: 'Gentry (ACCOUN)' },
  { entity: 'MedRock FL', positionId: '000687', who: 'Cortese (ADMIN, terminated)' },
  { entity: 'MedRock TN', positionId: '000300', who: 'Ahmed (ADMIN)' },
  { entity: 'MedRock TN', positionId: '000309', who: 'Cachet (ADMIN)' },
];

async function main(): Promise<void> {
  console.log(`mode=${apply ? 'APPLY' : 'PREVIEW (no writes)'} — ${ROWS.length} rows, class 'Allocate - %'`);
  for (const r of ROWS) {
    if (apply) {
      const id = await upsertEmployeeRule({
        entity: r.entity, positionId: r.positionId, departmentName: null,
        className: 'Allocate - %', cogsOverride: null, active: true, reviewed: true,
      });
      console.log(`  upserted #${id}  ${r.entity} ${r.positionId}  ${r.who}`);
    } else {
      console.log(`  would upsert  ${r.entity} ${r.positionId}  ${r.who}`);
    }
  }
  if (apply) {
    const check = await getRdsPool().query<{ entity: string; position_id: string; class_name: string }>(
      `SELECT entity, position_id, class_name FROM accounting.payroll_employee_map
        WHERE class_name = 'Allocate - %' ORDER BY entity, position_id`,
    );
    console.log(`\nread-back: ${check.rows.length} rows now carry 'Allocate - %'`);
    for (const c of check.rows) console.log(`  ${c.entity} ${c.position_id}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
