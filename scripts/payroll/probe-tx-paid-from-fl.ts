/**
 * READ-ONLY: was Texas payroll run through the FLORIDA entity, and for how long?
 *
 * Carson, 2026-08-10: "tx was paid out of florida for some time so we need to consider that for
 * the rules?" That matters because TX-state employer taxes appearing on MRFL rows have two very
 * different readings:
 *   (a) one FL employee who happens to live in Texas — a rounding-error curiosity, correctly
 *       booked to FL's own employer-tax accounts (which is what the current rule does); or
 *   (b) Texas operations genuinely paid out of the Florida entity for a period — in which case
 *       those wages and taxes are FL-borne costs of a TX business and may belong with TX,
 *       through the inter-entity Due to/from accounts.
 *
 * This establishes which, from the data: when each pay group starts and stops, when TX-flavoured
 * columns appear on FL rows, and how big they are. Prints dates, columns, cost centres, counts and
 * dollars. No names.
 *   npx tsx scripts/payroll/probe-tx-paid-from-fl.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { costCenterFor } from '../../src/lib/payroll/cost-center';
import type { SensitiveRow } from '../../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface SrcRow {
  position_id: string;
  home_department: string | null;
  location: string | null;
  pay_group: string;
  pay_date: string;
  sensitive_encrypted: string;
}

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const sortDate = (d: string): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : d;
};

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL, max: 1,
    ssl: RDS_SSL, connectionTimeoutMillis: 30_000,
  });

  try {
    // ---- 1. Lifespan of each pay group -------------------------------------
    const { rows: spans } = await pool.query<{ pay_group: string; first: string; last: string; dates: string; people: string }>(
      `SELECT pay_group,
              min(to_date(pay_date,'MM/DD/YYYY'))::text AS first,
              max(to_date(pay_date,'MM/DD/YYYY'))::text AS last,
              count(DISTINCT pay_date)::text AS dates,
              count(DISTINCT position_id)::text AS people
         FROM source.payroll_history GROUP BY pay_group ORDER BY pay_group`,
    );
    console.log('\n=== pay-group lifespan (whole history) ===');
    for (const s of spans) {
      console.log(`  ${String(s.pay_group ?? '(null)').padEnd(6)} ${s.first} .. ${s.last}   ${s.dates} pay dates, ${s.people} people`);
    }

    // ---- 2. TX-flavoured signals on FL rows ---------------------------------
    const { rows } = await pool.query<SrcRow>(
      `SELECT position_id, home_department, location, pay_group, pay_date, sensitive_encrypted
         FROM source.payroll_history`,
    );

    // Any column naming Texas, seen on a MRFL row.
    const txColsOnFl = new Map<string, { total: number; hits: number; dates: Set<string>; ccs: Set<string>; people: Set<string> }>();
    // Departments/locations that look like TX regions, per pay group.
    const txDeptByGroup = new Map<string, Map<string, { dates: Set<string>; people: Set<string> }>>();

    for (const r of rows) {
      const dept = r.home_department ?? '';
      const loc = r.location ?? '';
      const looksTx = /texas|\bTX\b|austin|dallas|houston/i.test(`${dept} ${loc}`);
      if (looksTx) {
        const byDept = txDeptByGroup.get(r.pay_group ?? '(null)') ?? new Map();
        const k = `${dept} | loc=${loc}`;
        const cur = byDept.get(k) ?? { dates: new Set<string>(), people: new Set<string>() };
        cur.dates.add(r.pay_date);
        cur.people.add(r.position_id);
        byDept.set(k, cur);
        txDeptByGroup.set(r.pay_group ?? '(null)', byDept);
      }

      if ((r.pay_group ?? '') !== 'MRFL') continue;
      const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
      for (const [col, val] of Object.entries(s)) {
        if (typeof val !== 'number' || val === 0) continue;
        if (!/^TX\b|TEXAS/i.test(col)) continue;
        const cur = txColsOnFl.get(col) ?? { total: 0, hits: 0, dates: new Set<string>(), ccs: new Set<string>(), people: new Set<string>() };
        cur.total += val;
        cur.hits += 1;
        cur.dates.add(r.pay_date);
        cur.ccs.add(costCenterFor(dept));
        cur.people.add(r.position_id);
        txColsOnFl.set(col, cur);
      }
    }

    console.log('\n=== TX-named columns carried on MRFL (Florida) rows ===');
    if (txColsOnFl.size === 0) console.log('  (none)');
    for (const [col, v] of [...txColsOnFl].sort((a, b) => b[1].total - a[1].total)) {
      const dates = [...v.dates].sort((a, b) => sortDate(a).localeCompare(sortDate(b)));
      console.log(`  ${money(v.total).padStart(12)}  ${col}`);
      console.log(`       ${v.hits} row-hits · ${v.people.size} people · cc=[${[...v.ccs].sort().join(',')}]`);
      console.log(`       first ${dates[0]}  last ${dates[dates.length - 1]}  (${dates.length} pay dates)`);
    }

    console.log('\n=== Texas-looking departments/locations, by pay group ===');
    for (const [group, byDept] of [...txDeptByGroup].sort()) {
      console.log(`\n  ${group}:`);
      for (const [dept, v] of [...byDept].sort()) {
        const dates = [...v.dates].sort((a, b) => sortDate(a).localeCompare(sortDate(b)));
        console.log(`    ${dept}`);
        console.log(`      ${v.people.size} people · ${dates.length} pay dates · ${dates[0]} .. ${dates[dates.length - 1]}`);
      }
    }

    // ---- 3. Did anyone move from MRFL to MRTX? ------------------------------
    const groupsByPerson = new Map<string, Map<string, string[]>>();
    for (const r of rows) {
      const byGroup = groupsByPerson.get(r.position_id) ?? new Map<string, string[]>();
      const pg = r.pay_group ?? '(null)';
      byGroup.set(pg, [...(byGroup.get(pg) ?? []), r.pay_date]);
      groupsByPerson.set(r.position_id, byGroup);
    }
    const movers = [...groupsByPerson.entries()].filter(([, g]) => g.has('MRFL') && g.has('MRTX'));
    console.log(`\n=== people who appear in BOTH MRFL and MRTX — ${movers.length} ===`);
    for (const [pos, g] of movers.slice(0, 25)) {
      const fl = (g.get('MRFL') ?? []).sort((a, b) => sortDate(a).localeCompare(sortDate(b)));
      const tx = (g.get('MRTX') ?? []).sort((a, b) => sortDate(a).localeCompare(sortDate(b)));
      console.log(`  position ${pos}: FL ${fl[0]}..${fl[fl.length - 1]} (${fl.length})  ->  TX ${tx[0]}..${tx[tx.length - 1]} (${tx.length})`);
    }
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
