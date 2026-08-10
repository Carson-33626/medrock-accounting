/**
 * One-off repair of accounting.payroll_account_map, from the 2026-08-06 accounting meeting.
 *
 * DEFAULT IS A DRY RUN. Pass --apply to write.
 *   npx tsx scripts/payroll/repair-account-map.ts
 *   npx tsx scripts/payroll/repair-account-map.ts --apply
 *
 * Three problems, all discovered 2026-08-07:
 *
 * 1. FIVE DEAD RULES. resolveLine matches cost_center exactly or on the pooled '*', so a rule
 *    holding anything else never fires: it saves cleanly, does nothing, and the column it was
 *    meant to map keeps re-surfacing as "new column detected" forever. Written through the
 *    Mappings tab's free-text cost-center box (now a constrained dropdown, plus server-side
 *    validation, so no new ones can appear).
 *
 * 2. FMLA MIS-CODING. A hand-made cost_center '*' rule sent EVERY cost center's FMLA to
 *    COGS - Pharmacists Wages. FL's MARKET ($8,938), LAB ($3,656) and CS ($2,775) FMLA — and
 *    TN's LAB ($1,440) — were landing in Pharmacists COGS. FMLA - EARNING is now seeded per cost
 *    center like its sibling wage columns, so the wildcard must go.
 *
 * 3. SUPERSEDED ADMIN OVERTIME. ADMIN overtime currently posts to 'Administrative Wages' (the
 *    REGULAR wage account) because the July attempt to point it at the dedicated
 *    'Administrative - OT Wages' was one of the dead rules. The seed now supplies the dedicated
 *    account for ADMIN and ACCOUN. Leaving the old rules active would be worse than either
 *    alone: two cost-center-specific rules in the SAME posting direction both fire, so the
 *    overtime would post TWICE. These must be deactivated before the seed is applied.
 *
 * Deactivates rather than deletes wherever the row is evidence of intent, so the history stays
 * auditable; deletes only the rows that are pure corruption.
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

interface RuleRow {
  id: number;
  entity: string;
  adp_column: string;
  cost_center: string;
  posting_type: string;
  account_name: string;
  is_cogs: boolean;
  active: boolean;
}

const VALID_CC = new Set(['*', 'LAB', 'PHARM', 'RD', 'ADMIN', 'ACCOUN', 'CS', 'DATA', 'SHIP', 'MARKET', 'DFLT']);

function show(label: string, rows: RuleRow[]): void {
  console.log(`\n=== ${label} — ${rows.length} ===`);
  for (const r of rows) {
    console.log(
      `  id=${String(r.id).padStart(5)} ${r.active ? 'active  ' : 'inactive'} ${r.entity.padEnd(12)} ` +
      `cc=${JSON.stringify(r.cost_center).padEnd(12)} ${r.adp_column.padEnd(28)} ${r.posting_type.padEnd(6)} -> ${r.account_name}`,
    );
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });

  try {
    const { rows: all } = await pool.query<RuleRow>(
      `SELECT id, entity, adp_column, cost_center, posting_type, account_name, is_cogs, active
         FROM accounting.payroll_account_map ORDER BY id`,
    );

    // (1) Anything whose cost_center can never match a payroll row.
    const dead = all.filter((r) => !VALID_CC.has(r.cost_center));

    // (2) The FMLA wildcard that mis-coded three cost centers, plus its self-cancelling Credit
    //     twin. Both are superseded by the per-cost-center FMLA rules the seed now emits.
    const fmlaWildcard = all.filter(
      (r) => r.adp_column === 'FMLA - EARNING' && r.cost_center === '*',
    );

    // (3) ADMIN/ACCOUN overtime still pointed at the REGULAR wage account. Same direction and
    //     same cost center as the seeded dedicated-OT rule, so both would fire.
    const supersededOt = all.filter(
      (r) =>
        /^OVERTIME (PREMIUM|STRAIGHT) - EARNING$/.test(r.adp_column) &&
        (r.cost_center === 'ADMIN' || r.cost_center === 'ACCOUN') &&
        r.account_name === 'Payroll Expense -:Administrative Wages' &&
        r.active,
    );

    show('DEAD — cost_center can never match (DELETE)', dead);
    show('FMLA wildcard — mis-coded non-pharmacists (DELETE)', fmlaWildcard);
    show('Superseded ADMIN/ACCOUN overtime — would double-book (DEACTIVATE)', supersededOt);

    const toDelete = [...dead, ...fmlaWildcard];
    const toDeactivate = supersededOt;

    if (!APPLY) {
      console.log(`\nDry run only. --apply would DELETE ${toDelete.length} and DEACTIVATE ${toDeactivate.length}.`);
      console.log('Run scripts/payroll/seed-account-map.ts --apply AFTERWARDS to install the replacements.');
      return;
    }

    if (toDelete.length > 0) {
      const res = await pool.query(
        `DELETE FROM accounting.payroll_account_map WHERE id = ANY($1::bigint[])`,
        [toDelete.map((r) => r.id)],
      );
      console.log(`\ndeleted ${res.rowCount} rule(s)`);
    }
    if (toDeactivate.length > 0) {
      const res = await pool.query(
        `UPDATE accounting.payroll_account_map SET active = false, updated_at = now()
          WHERE id = ANY($1::bigint[])`,
        [toDeactivate.map((r) => r.id)],
      );
      console.log(`deactivated ${res.rowCount} rule(s)`);
    }
    console.log('\nNow run: npx tsx scripts/payroll/seed-account-map.ts --apply');
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
