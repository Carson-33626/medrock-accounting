/**
 * Class the Dallas-Region marketers on the MedRock FL payroll as `Allocate - TX`.
 *
 * WHY: Texas sales was run through the Florida entity before the TX pay group opened
 * (2025-11-07), and MedRock FL's QuickBooks carries Austin/Dallas/Houston Region departments to
 * express that. Whoever set this up classed both HOUSTON Region marketers `Allocate - TX` and
 * marked them reviewed — but both DALLAS Region marketers were missed, leaving $173,392.11 of
 * gross pay sitting in Florida that the established convention says belongs to Texas.
 * Carson, 2026-08-10: "TX on FL would be Regina & any texas marketer" -> match the precedent.
 *
 * `Allocate - TX` is the 100%-passthrough class (qb-pool.ts classifyAllocateFlag), so month-end
 * moves the whole cost to TX rather than splitting it.
 *
 * SAFE BY CONSTRUCTION: the employee map is keyed on (entity, position_id), so this touches ONLY
 * the MedRock FL rows. Position 000717 already demonstrates the pattern — it has a separate
 * MedRock TX row with no class — which is why classing an FL row cannot leak into someone's TX
 * payroll after they transfer.
 *
 * DEFAULT IS A DRY RUN. Pass --apply.
 *   npx tsx scripts/payroll/class-dallas-marketers-tx.ts
 *   npx tsx scripts/payroll/class-dallas-marketers-tx.ts --apply
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const APPLY = process.argv.includes('--apply');
const ENTITY = 'MedRock FL';
const TARGET_CLASS = 'Allocate - TX';
/** Dallas Region marketers, from probe-tx-on-fl-population.ts. */
const POSITIONS = ['000198', '000760', '000801'];

interface MapRow {
  id: number;
  entity: string;
  position_id: string;
  department_name: string | null;
  class_name: string | null;
  active: boolean;
  reviewed: boolean;
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL, max: 1,
    ssl: RDS_SSL, connectionTimeoutMillis: 30_000,
  });

  try {
    const { rows } = await pool.query<MapRow>(
      `SELECT id, entity, position_id, department_name, class_name, active, reviewed
         FROM accounting.payroll_employee_map
        WHERE entity = $1 AND position_id = ANY($2)
        ORDER BY position_id`,
      [ENTITY, POSITIONS],
    );

    console.log(`\n${ENTITY} employee-map rows for the Dallas marketers — ${rows.length} found`);
    for (const r of rows) {
      console.log(`  id=${r.id} pos=${r.position_id} dept=${r.department_name ?? '(none)'} class=${r.class_name ?? '(none)'} reviewed=${r.reviewed}`);
    }

    // Guard: only touch rows that really are Dallas Region and are not already classed. A row that
    // has drifted to another department must not be swept along by a hardcoded position list.
    const changeable = rows.filter((r) => r.department_name === 'Dallas Region' && r.class_name !== TARGET_CLASS);
    const skipped = rows.filter((r) => !changeable.includes(r));

    console.log(`\n=== WOULD SET class_name = '${TARGET_CLASS}' — ${changeable.length} row(s) ===`);
    for (const r of changeable) console.log(`  + id=${r.id} pos=${r.position_id} (${r.department_name})`);
    if (skipped.length > 0) {
      console.log(`\n=== SKIPPED — ${skipped.length} ===`);
      for (const r of skipped) {
        console.log(`  - id=${r.id} pos=${r.position_id} dept=${r.department_name ?? '(none)'} class=${r.class_name ?? '(none)'}`);
      }
    }

    const missing = POSITIONS.filter((p) => !rows.some((r) => r.position_id === p));
    if (missing.length > 0) console.log(`\n  NOTE: no ${ENTITY} map row for position(s): ${missing.join(', ')}`);

    if (!APPLY) {
      console.log(`\nDry run only. Re-run with --apply, then regenerate drafts.`);
      return;
    }
    if (changeable.length === 0) {
      console.log('\nNothing to change.');
      return;
    }

    const res = await pool.query(
      `UPDATE accounting.payroll_employee_map
          SET class_name = $1, reviewed = true, updated_at = now()
        WHERE id = ANY($2::bigint[])`,
      [TARGET_CLASS, changeable.map((r) => r.id)],
    );
    console.log(`\nUpdated ${res.rowCount} row(s). Now regenerate drafts:`);
    console.log('  RDS_CONNECT_TIMEOUT_MS=60000 npx tsx scripts/payroll/regen-drafts.ts 2026-01-01 2026-12-31');
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
