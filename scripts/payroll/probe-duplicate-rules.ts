/**
 * READ-ONLY: find account-map rules that DUPLICATE each other from the resolver's point of view.
 *
 * WHY: Barbara reported the mapping panel showing the same rule several times, plus a save that
 * did not take (FMLA - EARNING, MedRock FL 04/10 — TODO.md 2026-08-06). The natural key behind
 * the save is
 *     (entity, adp_column, cost_center, posting_type, account_name)
 * — five columns, INCLUDING account_name. So re-pointing a mapping at a different account does
 * not move the existing rule, it INSERTS A SECOND ONE and leaves the first active. To the
 * accountant the old rule "came back"; to `resolveLine`, which returns EVERY in-direction match,
 * both rules fire and the column is booked twice.
 *
 * This reports, per (entity, adp_column, cost_center, posting_type):
 *   - DOUBLE-BOOKING: 2+ ACTIVE rules → every dollar in that column posts more than once.
 *   - shadowed: 1 active + inactive siblings → harmless, but it is what the panel renders as
 *     "duplicates" if inactive rows are shown.
 * Plus the specificity hazard: an ACTIVE cost-center-specific rule and an ACTIVE pooled '*' rule
 * on the same column+direction (the pooled one loses, so its dollars silently vanish from it).
 *
 * Writes nothing.
 *   npx tsx scripts/payroll/probe-duplicate-rules.ts
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

const groupKey = (r: RuleRow): string =>
  [r.entity, r.adp_column, r.cost_center, r.posting_type].join(' ¦ ');

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: RDS_SSL,
    connectionTimeoutMillis: Number(process.env.RDS_CONNECT_TIMEOUT_MS) || 30_000,
  });

  try {
    const { rows } = await pool.query<RuleRow>(
      `SELECT id, entity, adp_column, cost_center, posting_type, account_name, active,
              to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
         FROM accounting.payroll_account_map
        ORDER BY entity, adp_column, cost_center, posting_type, id`,
    );
    console.log(`\n${rows.length} total rules (${rows.filter((r) => r.active).length} active)\n`);

    const groups = new Map<string, RuleRow[]>();
    for (const r of rows) {
      const k = groupKey(r);
      const list = groups.get(k);
      if (list) list.push(r);
      else groups.set(k, [r]);
    }

    const doubleBooking: Array<[string, RuleRow[]]> = [];
    const shadowed: Array<[string, RuleRow[]]> = [];
    for (const [k, members] of groups) {
      const active = members.filter((m) => m.active);
      if (active.length > 1) doubleBooking.push([k, members]);
      else if (members.length > 1) shadowed.push([k, members]);
    }

    console.log('=== DOUBLE-BOOKING: 2+ ACTIVE rules on the same column + cost centre + direction ===');
    if (doubleBooking.length === 0) console.log('  none\n');
    for (const [k, members] of doubleBooking) {
      console.log(`  ${k}`);
      for (const m of members) {
        console.log(`     ${m.active ? 'ACTIVE  ' : 'inactive'} #${m.id} -> ${m.account_name}  (updated ${m.updated_at ?? '?'})`);
      }
    }

    console.log(`\n=== shadowed: 1 active + inactive sibling(s) — panel noise, not a posting bug ===`);
    if (shadowed.length === 0) console.log('  none');
    for (const [k, members] of shadowed) {
      const acct = members.find((m) => m.active)?.account_name ?? '(none active)';
      console.log(`  ${k} -> ${acct}  (+${members.length - 1} inactive)`);
    }

    // Specificity hazard: a cost-center-specific ACTIVE rule beats an ACTIVE pooled '*' rule on the
    // same column+direction, so the pooled rule silently stops applying to that cost centre.
    console.log(`\n=== pooled '*' rule competing with a cost-centre-specific rule (same column + direction) ===`);
    const byColumnDirection = new Map<string, RuleRow[]>();
    for (const r of rows) {
      if (!r.active) continue;
      const k = [r.entity, r.adp_column, r.posting_type].join(' ¦ ');
      const list = byColumnDirection.get(k);
      if (list) list.push(r);
      else byColumnDirection.set(k, [r]);
    }
    let competing = 0;
    for (const [k, members] of byColumnDirection) {
      const pooled = members.filter((m) => m.cost_center === '*');
      const specific = members.filter((m) => m.cost_center !== '*');
      if (pooled.length > 0 && specific.length > 0) {
        competing += 1;
        console.log(`  ${k}`);
        console.log(`     pooled   -> ${pooled.map((p) => `#${p.id} ${p.account_name}`).join(', ')}`);
        console.log(`     specific -> ${specific.map((s) => `#${s.id} [${s.cost_center}] ${s.account_name}`).join(', ')}`);
      }
    }
    if (competing === 0) console.log('  none');

    console.log(
      `\nSummary: ${doubleBooking.length} double-booking group(s), ${shadowed.length} shadowed group(s), ` +
      `${competing} pooled-vs-specific overlap(s).`,
    );
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
