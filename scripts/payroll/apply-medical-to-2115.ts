/**
 * Payroll mapping ruling (Kristi Thiel 2026-09-01, Carson "implement the ruling now" 2026-09-02):
 * employee health withholdings credit 2115 Accrued Payroll Liability — the account the Aetna
 * autopay actually clears — instead of 2110 Payroll Withholdings, where $73,130 YTD had piled up
 * with nothing ever relieving it (see docs/accounting-requests/2026-08-27-kristi-accrued-liabilities-review.md,
 * driver #2).
 *
 * Scope = every active Credit rule in the Health bucket for MedRock FL / TN / TX:
 *   MEDICAL - EE PRE-TAX, DENTAL - EE PRE-TAX / POST-TAX, VISION - EE PRE-TAX / POST-TAX, and the
 *   MEDICAL - ER credit leg (its cost-center Debit legs already hit 2115, so ER medical nets to
 *   zero on 2115 and the employer expense is carried by the monthly Aetna JE).
 * MEDICAL - ER stays mapped: an unmapped column makes a run unpostable (reconcile requires zero).
 *
 * Mechanism: upsertAccountRule() with the new account_name; its deactivateSupersededAccountRules()
 * retires the old 'Payroll Withholdings' rule in the same (entity, column, cost_center, direction)
 * slot in the same transaction, so nothing double-books.
 *
 * Dry-run by default; pass --live to write. Only NEW draft builds pick this up — posted JEs are
 * untouched (Kristi's ~$56.9k reclass covers history) and existing unposted drafts keep the old
 * lines until rebuilt.
 *   npx tsx scripts/payroll/apply-medical-to-2115.ts [--live]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getAccountMap, upsertAccountRule } from '../../src/lib/payroll/store';
import type { AccountMapRule, Entity } from '../../src/lib/payroll/types';

const LIVE = process.argv.includes('--live');
/** --revert: put the Health-bucket credits back on 2110. Carson 2026-09-02: "revert, Barbara's
 *  accountant, we follow her lead" — Barbara's Aetna allocations (FL JE 53496 / TN 20701 / TX 1926,
 *  keyed 08-27) relieve the employee share out of 2110, so payroll must keep crediting 2110. */
const REVERT = process.argv.includes('--revert');
const ENTITIES: readonly Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'] as Entity[];
const FROM_ACCOUNT = REVERT ? 'Accrued Payroll Liability' : 'Payroll Withholdings';
const TO_ACCOUNT = REVERT ? 'Payroll Withholdings' : 'Accrued Payroll Liability';

async function main(): Promise<void> {
  console.log(`${REVERT ? '[REVERT to 2110] ' : ''}${LIVE ? '*** LIVE: writing accounting.payroll_account_map ***' : '--- DRY RUN (pass --live to write) ---'}`);
  let planned = 0;
  for (const entity of ENTITIES) {
    const rules = await getAccountMap(entity);
    const targets = rules.filter((r) => r.postingType === 'Credit' && r.creditBucket === 'Health' && r.accountName === FROM_ACCOUNT && r.active);
    const alreadyDone = rules.filter((r) => r.postingType === 'Credit' && r.creditBucket === 'Health' && r.accountName === TO_ACCOUNT && r.active);
    console.log(`\n${entity}: ${targets.length} Health credit rule(s) on "${FROM_ACCOUNT}"; ${alreadyDone.length} already on "${TO_ACCOUNT}"`);
    for (const r of targets) {
      const next: AccountMapRule = { ...r, accountName: TO_ACCOUNT };
      console.log(`  ${LIVE ? 'MOVE' : 'would move'} #${r.id} ${r.adpColumn.padEnd(24)} cc=${r.costCenter} ${FROM_ACCOUNT} -> ${TO_ACCOUNT} (bucket ${r.creditBucket})`);
      planned++;
      if (LIVE) {
        const newId = await upsertAccountRule(next);
        console.log(`    -> rule #${newId} active; old #${r.id} superseded`);
      }
    }
    // ER medical debit legs are already on 2115 — report so the reviewer sees the full picture.
    const erDebits = rules.filter((r) => r.adpColumn === 'MEDICAL - ER' && r.postingType === 'Debit' && r.active);
    console.log(`  (MEDICAL - ER debit legs: ${erDebits.length} rule(s), all on "${[...new Set(erDebits.map((r) => r.accountName))].join('|')}")`);
  }
  if (LIVE) {
    console.log('\n--- verification: active Health credit rules after write ---');
    for (const entity of ENTITIES) {
      const rules = await getAccountMap(entity);
      for (const r of rules.filter((x) => x.postingType === 'Credit' && x.creditBucket === 'Health' && x.active)) {
        console.log(`  ${entity} #${r.id} ${r.adpColumn.padEnd(24)} -> ${r.accountName}`);
      }
    }
  }
  console.log(`\n${planned} rule(s) ${LIVE ? 'moved' : 'would move'}.`);
  process.exit(0);
}

void main().catch((err) => { console.error(err); process.exit(1); });
