/**
 * READ-ONLY: integrity audit of accounting.payroll_account_map.
 *
 * Triggered by finding two rules on MedRock FL whose cost_center is '*admin' / '*Admin' —
 * an asterisk-prefixed, mixed-case value that matches NOTHING. resolveLine only accepts an
 * exact cost-center code or the literal pooled wildcard '*', so such a rule is dead on
 * arrival: it never fires, and the column it was meant to map keeps re-prompting as "new
 * column detected". Suspected residue of the mapping-rule save bug (TODO.md 2026-08-06).
 *
 * Reports: every distinct cost_center value, which are canonical, and every rule whose
 * cost_center can never match a row.
 *   npx tsx scripts/payroll/probe-mapping-integrity.ts
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

/** The canonical cost-center codes, plus the pooled wildcard. Anything else is dead. */
const VALID = new Set(['*', 'LAB', 'PHARM', 'RD', 'ADMIN', 'ACCOUN', 'CS', 'DATA', 'SHIP', 'MARKET']);

interface RuleRow {
  id: number;
  entity: string;
  adp_column: string;
  cost_center: string;
  posting_type: string;
  account_name: string;
  active: boolean;
  updated_at: string | null;
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: RDS_SSL,
  });

  try {
    const { rows } = await pool.query<RuleRow>(
      `SELECT id, entity, adp_column, cost_center, posting_type, account_name, active,
              to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
         FROM accounting.payroll_account_map
        ORDER BY entity, adp_column, cost_center`,
    );
    console.log(`\n${rows.length} total rules\n`);

    const byCc = new Map<string, number>();
    for (const r of rows) byCc.set(r.cost_center, (byCc.get(r.cost_center) ?? 0) + 1);
    console.log('=== distinct cost_center values ===');
    for (const [cc, n] of [...byCc].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${VALID.has(cc) ? 'ok  ' : 'DEAD'} ${JSON.stringify(cc).padEnd(14)} ${n} rule(s)`);
    }

    const dead = rows.filter((r) => !VALID.has(r.cost_center));
    console.log(`\n=== DEAD RULES (cost_center can never match) — ${dead.length} ===`);
    for (const r of dead) {
      console.log(
        `  id=${String(r.id).padStart(5)} ${r.active ? 'active  ' : 'inactive'} ${r.entity.padEnd(12)} cc=${JSON.stringify(r.cost_center).padEnd(12)} ${r.adp_column.padEnd(30)} -> ${r.account_name}  updated=${r.updated_at ?? '?'}`,
      );
    }

    // Duplicate detection on the documented unique key.
    const key = (r: RuleRow): string =>
      [r.entity, r.adp_column, r.cost_center, r.posting_type, r.account_name].join('¦');
    const dupes = new Map<string, RuleRow[]>();
    for (const r of rows) dupes.set(key(r), [...(dupes.get(key(r)) ?? []), r]);
    const realDupes = [...dupes.entries()].filter(([, v]) => v.length > 1);
    console.log(`\n=== DUPLICATE (entity, column, cc, posting_type, account) — ${realDupes.length} ===`);
    for (const [k, v] of realDupes) {
      console.log(`  ${v.length}x  ${k.replace(/¦/g, ' | ')}  ids=${v.map((x) => x.id).join(',')}`);
    }

    // Same (entity, column, cc) mapped to MORE THAN ONE account — an ambiguity that makes
    // the JE non-deterministic and is the likeliest cause of a "duplicate panel" in the UI.
    const target = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.active) continue;
      const k = [r.entity, r.adp_column, r.cost_center].join('¦');
      target.set(k, (target.get(k) ?? new Set<string>()).add(`${r.posting_type}:${r.account_name}`));
    }
    const ambiguous = [...target.entries()].filter(([, v]) => v.size > 1);
    console.log(`\n=== AMBIGUOUS: one (entity, column, cost_center) -> multiple accounts — ${ambiguous.length} ===`);
    for (const [k, v] of ambiguous) {
      console.log(`  ${k.replace(/¦/g, ' | ')}`);
      for (const a of [...v].sort()) console.log(`      ${a}`);
    }
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
