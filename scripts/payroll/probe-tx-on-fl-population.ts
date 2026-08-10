/**
 * READ-ONLY: identify the TX-paid-from-Florida population.
 *
 * Carson, 2026-08-10: "TX on FL would be Regina & any texas marketer." That is identifiable after
 * all — MedRock FL's QuickBooks carries Austin Region / Dallas Region / Houston Region
 * departments, i.e. Texas sales regions sitting on the FLORIDA entity, and FL's employee map
 * already classes some people 'Allocate - TX'. So the population is:
 *   - anyone on the MRFL pay group named Regina, and
 *   - anyone on MRFL whose QB department is a Texas region.
 *
 * Shows, for each: their pay-date span on FL, cost centre, current employee-map department and
 * class, and whether they are ALREADY classed Allocate - TX. That last column is the important
 * one — it says how much of this is already handled and how much is missing.
 *
 * Employee names are a PLAINTEXT column in source.payroll_history (only the dollar figures are
 * encrypted), so naming Regina here exposes nothing that the payroll page does not already show.
 *   npx tsx scripts/payroll/probe-tx-on-fl-population.ts
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

/** Texas sales regions that exist as DEPARTMENTS on the MedRock FL QuickBooks company. */
const TX_REGIONS = ['Austin Region', 'Dallas Region', 'Houston Region'];

interface PersonRow {
  position_id: string;
  name: string;
  pay_group: string;
  home_department: string | null;
  first: string;
  last: string;
  dates: string;
}
interface MapRow {
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
    // Everyone on FL, with their span — so a name search and a region search share one query.
    const { rows: people } = await pool.query<PersonRow>(
      `SELECT position_id, name, pay_group, home_department,
              min(to_date(pay_date,'MM/DD/YYYY'))::text AS first,
              max(to_date(pay_date,'MM/DD/YYYY'))::text AS last,
              count(DISTINCT pay_date)::text AS dates
         FROM source.payroll_history
        WHERE pay_group IN ('MRFL','MRTX')
        GROUP BY position_id, name, pay_group, home_department
        ORDER BY name, pay_group`,
    );

    const { rows: maps } = await pool.query<MapRow>(
      `SELECT entity, position_id, department_name, class_name, active, reviewed
         FROM accounting.payroll_employee_map`,
    );
    const mapFor = (entity: string, pos: string): MapRow | undefined =>
      maps.find((m) => m.entity === entity && m.position_id === pos);

    const show = (p: PersonRow): void => {
      const entity = p.pay_group === 'MRFL' ? 'MedRock FL' : 'MedRock TX';
      const m = mapFor(entity, p.position_id);
      const cls = m?.class_name ?? '(no class)';
      const flag = cls === 'Allocate - TX' ? '  <-- already Allocate - TX' : '';
      console.log(
        `    ${p.name.padEnd(28)} pos ${p.position_id}  ${p.pay_group}  ${String(p.home_department ?? '').padEnd(22)}` +
        `\n        ${p.first} .. ${p.last} (${p.dates} pay dates)  map: dept=${m?.department_name ?? '(none)'} class=${cls}${flag}`,
      );
    };

    console.log('\n================ 1. Anyone named Regina ================');
    const reginas = people.filter((p) => /regina/i.test(p.name));
    if (reginas.length === 0) console.log('  (nobody matching "Regina" on MRFL/MRTX)');
    for (const p of reginas) show(p);

    console.log('\n================ 2. Texas-region marketers ================');
    console.log('   (MRFL people whose employee-map department is a Texas region)');
    const txMapped = maps.filter(
      (m) => m.entity === 'MedRock FL' && m.department_name !== null && TX_REGIONS.includes(m.department_name),
    );
    if (txMapped.length === 0) console.log('  (none)');
    for (const m of txMapped) {
      const p = people.find((x) => x.position_id === m.position_id && x.pay_group === 'MRFL');
      if (p) show(p);
      else console.log(`    position ${m.position_id} — map row exists (dept=${m.department_name}, class=${m.class_name ?? '(none)'}) but no MRFL payroll rows`);
    }

    console.log('\n================ 3. Every FL employee-map row already classed Allocate - TX ================');
    const already = maps.filter((m) => m.entity === 'MedRock FL' && m.class_name === 'Allocate - TX');
    console.log(`   ${already.length} row(s)`);
    for (const m of already) {
      const p = people.find((x) => x.position_id === m.position_id && x.pay_group === 'MRFL');
      console.log(`    pos ${m.position_id}  ${p ? p.name.padEnd(28) : '(no MRFL rows)'.padEnd(28)} dept=${m.department_name ?? '(none)'} active=${m.active} reviewed=${m.reviewed}`);
    }

    console.log('\n================ 4. All FL marketing people, for context ================');
    const flMarket = people.filter((p) => p.pay_group === 'MRFL' && /MARKET/i.test(p.home_department ?? ''));
    console.log(`   ${flMarket.length} MRFL rows in MARKET cost centre`);
    for (const p of flMarket) show(p);
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
