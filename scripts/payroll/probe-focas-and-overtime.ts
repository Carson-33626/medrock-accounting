/**
 * READ-ONLY. Answers two 2026-08-06 accounting-meeting questions in one pass:
 *
 *   (#8) "clone the same accounts to FOCAS" — what ADP columns do FOCS rows actually
 *        carry, and how many of them would a straight clone of the FL/TN/TX seed cover?
 *        Anything left over is genuinely FOCAS-specific (state UI, workers' comp,
 *        garnishment pool) and needs Barbara/Amy to name the account.
 *
 *   (#7) "overtime rules should have populated already, why are we being prompted for a
 *        new overtime rule?" — which entity/cost-center pairs carry non-zero OT dollars
 *        but resolve to no active rule.
 *
 * Prints column names, cost centers, and dollar totals only — no employee names, no PII.
 *   npx tsx scripts/payroll/probe-focas-and-overtime.ts [startISO] [endISO]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { costCenterFor } from '../../src/lib/payroll/cost-center';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import { buildSeedAccountMap } from './account-map-seed-data';
import type { SensitiveRow } from '../../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface SrcRow {
  home_department: string | null;
  pay_group: string;
  pay_date: string;
  sensitive_encrypted: string;
}

interface DbRule {
  entity: string;
  adp_column: string;
  cost_center: string;
  posting_type: string;
  account_name: string;
  active: boolean;
}

/** One observed (column, cost_center) pair with its dollar weight. */
interface Observation {
  total: number;
  rows: number;
  costCenters: Set<string>;
}

/**
 * Mirrors of build-je.ts's two suppression predicates (they are module-private there).
 * A column matching either is NEVER a real mapping gap: taxable wage bases and ADP report
 * aggregates/hours carry no GL account by design, and mapping them would double-count.
 * Kept byte-identical to build-je.ts:7 and build-je.ts:18-19.
 */
const isTaxableBase = (col: string): boolean => /TAXABLE\s*$/.test(col.trim());
const isReportAggregateColumn = (col: string): boolean =>
  /\bHOURS\b|-\s*TOTAL\s*$|^TOTAL\b|^GROSS PAY$|^RATE AMOUNT$/.test(col.trim());
/** True when the column is informational — suppressed from the "new columns detected" worklist. */
const isInformational = (col: string): boolean => isTaxableBase(col) || isReportAggregateColumn(col);

const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');

  const start = process.argv[2] ?? '2026-01-01';
  const end = process.argv[3] ?? '2026-12-31';

  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: RDS_SSL,
  });

  try {
    const { rows } = await pool.query<SrcRow>(
      `SELECT home_department, pay_group, pay_date, sensitive_encrypted
         FROM source.payroll_history
        WHERE to_date(pay_date, 'MM/DD/YYYY') BETWEEN $1::date AND $2::date`,
      [start, end],
    );

    const { rows: dbRules } = await pool.query<DbRule>(
      `SELECT entity, adp_column, cost_center, posting_type, account_name, active
         FROM accounting.payroll_account_map`,
    );

    console.log(`\nRange ${start} .. ${end} — ${rows.length} source rows, ${dbRules.length} live account-map rules\n`);

    // entity -> column -> observation
    const byEntity = new Map<string, Map<string, Observation>>();
    const payGroupsSeen = new Map<string, string>();

    for (const r of rows) {
      const entity = entityForPayGroup(r.pay_group);
      if (!entity) continue;
      payGroupsSeen.set(r.pay_group, entity);
      const cc = costCenterFor(r.home_department ?? '');
      const sensitive: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
      const cols = byEntity.get(entity) ?? new Map<string, Observation>();
      for (const [col, val] of Object.entries(sensitive)) {
        if (typeof val !== 'number' || val === 0) continue;
        const obs = cols.get(col) ?? { total: 0, rows: 0, costCenters: new Set<string>() };
        obs.total += val;
        obs.rows += 1;
        obs.costCenters.add(cc);
        cols.set(col, obs);
      }
      byEntity.set(entity, cols);
    }

    console.log('Pay groups observed:');
    for (const [pg, ent] of [...payGroupsSeen].sort()) console.log(`  ${pg.padEnd(8)} -> ${ent}`);

    // ── Live-rule coverage per entity ────────────────────────────────────────
    const liveByEntity = new Map<string, DbRule[]>();
    for (const r of dbRules) {
      if (!r.active) continue;
      liveByEntity.set(r.entity, [...(liveByEntity.get(r.entity) ?? []), r]);
    }

    const resolves = (rules: DbRule[], col: string, cc: string): boolean =>
      rules.some((a) => a.adp_column === col && (a.cost_center === cc || a.cost_center === '*'));

    for (const [entity, cols] of [...byEntity].sort()) {
      const live = liveByEntity.get(entity) ?? [];
      console.log(`\n================ ${entity} ================`);
      console.log(`  ${cols.size} distinct non-zero columns · ${live.length} active live rules`);

      const unresolved: Array<[string, Observation, string[]]> = [];
      const suppressed: Array<[string, Observation]> = [];
      for (const [col, obs] of cols) {
        const missing = [...obs.costCenters].filter((cc) => !resolves(live, col, cc)).sort();
        if (missing.length === 0) continue;
        if (isInformational(col)) suppressed.push([col, obs]);
        else unresolved.push([col, obs, missing]);
      }
      unresolved.sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total));

      console.log(`\n  UNMAPPED — REAL, would prompt — ${unresolved.length} column(s):`);
      for (const [col, obs, missing] of unresolved) {
        console.log(
          `    ${money(obs.total).padStart(14)}  ${col}  [cc: ${missing.join(',')}] (${obs.rows} row-hits)`,
        );
      }
      console.log(`  (suppressed as informational hours/aggregate/taxable-base: ${suppressed.length} column(s))`);
    }

    // ── #7 Overtime focus ────────────────────────────────────────────────────
    console.log('\n\n################ OVERTIME (meeting item #7) ################');
    for (const [entity, cols] of [...byEntity].sort()) {
      const live = liveByEntity.get(entity) ?? [];
      // Only the dollar-postable OT columns matter — the "- HOURS" / "- TOTAL" variants are
      // informational and never prompt, so listing them here would be pure noise.
      const otCols = [...cols].filter(([c]) => /OVERTIME|\bOT\b/i.test(c) && !isInformational(c));
      if (otCols.length === 0) continue;
      console.log(`\n  ${entity}:`);
      for (const [col, obs] of otCols) {
        for (const cc of [...obs.costCenters].sort()) {
          const ok = resolves(live, col, cc);
          console.log(`    ${ok ? 'OK        ' : 'NO RULE ->'} ${col}  cc=${cc}  ${money(obs.total)}`);
        }
      }
    }

    // ── #8 FOCAS clone feasibility ───────────────────────────────────────────
    console.log('\n\n################ FOCAS CLONE (meeting item #8) ################');
    const focasCols = byEntity.get('FOCAS');
    if (!focasCols || focasCols.size === 0) {
      console.log('  No FOCS rows with non-zero columns in this range.');
    } else {
      // What would a straight clone of each seeded entity's rule set cover?
      for (const donor of ['MedRock FL', 'MedRock TN', 'MedRock TX'] as const) {
        const seed = buildSeedAccountMap(donor);
        const seedRules: DbRule[] = seed.map((s) => ({
          entity: donor,
          adp_column: s.adpColumn,
          cost_center: s.costCenter,
          posting_type: s.postingType,
          account_name: s.accountName,
          active: true,
        }));
        // Score against POSTABLE columns only. Informational columns need no rule, so counting
        // them as "gaps" would make every clone look far worse than it is.
        const postable = [...focasCols].filter(([col]) => !isInformational(col));
        let covered = 0;
        const gaps: Array<[string, Observation]> = [];
        for (const [col, obs] of postable) {
          const missing = [...obs.costCenters].filter((cc) => !resolves(seedRules, col, cc));
          if (missing.length === 0) covered += 1;
          else gaps.push([col, obs]);
        }
        console.log(
          `\n  Clone from ${donor}: covers ${covered}/${postable.length} postable FOCAS columns · ${gaps.length} gap(s)`,
        );
        gaps.sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total));
        for (const [col, obs] of gaps) {
          console.log(`      GAP ${money(obs.total).padStart(14)}  ${col}  [cc: ${[...obs.costCenters].sort().join(',')}]`);
        }
      }
    }
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
