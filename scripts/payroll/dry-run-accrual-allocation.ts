/**
 * READ-ONLY dry-run: build + PRINT the month-end accrual and its next-day reversal for ONE
 * entity + month. Posts NOTHING to QuickBooks, writes NOTHING to the DB — it only reads
 * payroll_history (decrypt-gated) and prints account/dept/class/memo/amount lines. Honors the
 * dry-run mandate. The manual ADMIN wage % allocation this script used to also print was
 * retired 2026-07 — see scripts/payroll/eom-dryrun.ts for the revenue-rule month-end allocation.
 *
 *   npx tsx scripts/payroll/dry-run-accrual-allocation.ts "MedRock TN" 2026-06
 *
 * Env: .env.local for RDS (RDS_DATABASE_URL, PAYROLL_ENC_KEY), then .env.vercel overrides
 * ONLY the QUICKBOOKS_* keys (unused here — no QB import in this script — kept identical to
 * dry-run-reconcile.ts's env-load block for consistency / in case future steps need it).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const localEnvText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of localEnvText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const QB_ENV_KEYS = new Set(['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET', 'QUICKBOOKS_ENVIRONMENT', 'QUICKBOOKS_REDIRECT_URI']);
const vercelEnvText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of vercelEnvText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && QB_ENV_KEYS.has(m[1])) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import type { AccountMapRule, Entity, EmployeeMapRule, JournalDraft, PayrollRow } from '../../src/lib/payroll/types';
import { entityForPayGroup, POSTABLE_ENTITIES } from '../../src/lib/payroll/entity';
import { buildJournal } from '../../src/lib/payroll/build-je';
import { monthEndIso, type Month } from '../../src/lib/payroll/month';
import { buildSeedAccountMap } from './account-map-seed-data';
import { buildMarketerEmployeeMap } from './employee-map-seed-data';

function printDraft(d: JournalDraft): void {
  console.log(`\n== ${d.docNumber ?? '(pay-date)'}  TxnDate ${d.txnDate ?? d.payDate}  [${d.kind ?? 'pay_date'}] ${d.entity} ==`);
  if (d.privateNote) console.log(`   note: ${d.privateNote}`);
  for (const l of d.lines) {
    const dept = l.departmentName ? ` [dept:${l.departmentName}]` : '';
    const cls = l.className ? ` [class:${l.className}]` : '';
    console.log(`   ${l.postingType.padEnd(6)} ${l.amount.toFixed(2).padStart(12)}  ${l.accountName}${dept}${cls}  — ${l.memo}`);
  }
  console.log(`   ---- Dr ${d.totalDebits.toFixed(2)}  Cr ${d.totalCredits.toFixed(2)}  variance ${d.variance.toFixed(2)}`);
}

async function main(): Promise<void> {
  const entityArg = process.argv[2];
  const monthArg = process.argv[3]; // YYYY-MM

  if (!entityArg || !monthArg || !/^\d{4}-\d{2}$/.test(monthArg)) {
    throw new Error('usage: dry-run-accrual-allocation.ts "<Entity>" YYYY-MM  (Entity: MedRock FL | MedRock TN | MedRock TX | FOCAS)');
  }
  if (!POSTABLE_ENTITIES.includes(entityArg as Entity)) {
    throw new Error(`usage: entity must be one of ${POSTABLE_ENTITIES.join(', ')} — got "${entityArg}"`);
  }
  const entity: Entity = entityArg as Entity;

  const [yStr, moStr] = monthArg.split('-');
  const year = Number(yStr);
  const month = Number(moStr);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`usage: invalid month in "${monthArg}"`);
  }
  const m: Month = { year, month };
  const m1: Month = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };

  const startIso = `${yStr}-${moStr}-01`;
  const endIso = monthEndIso(m1); // covers month M's own pay dates AND M+1's (accrual pay dates land in M+1)

  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) {
    console.error('PAYROLL_ENC_KEY not set (.env.local) — cannot decrypt payroll rows. Aborting.');
    process.exit(1);
    return;
  }

  const { RdsPayrollSource } = await import('../../src/lib/payroll/source');
  const source = new RdsPayrollSource(key);
  const allRows: PayrollRow[] = await source.fetchRange(startIso, endIso);
  console.log(`Fetched ${allRows.length} total payroll_history rows for ${startIso}..${endIso} (all entities/pay-groups).`);

  const fullEmployeeMap: EmployeeMapRule[] = await buildMarketerEmployeeMap();

  const allDrafts: JournalDraft[] = [];
  for (const e of POSTABLE_ENTITIES) {
    const rows = allRows.filter((r) => entityForPayGroup(r.pay_group) === e);
    if (rows.length === 0) continue;

    const accountMap: AccountMapRule[] = buildSeedAccountMap(e);
    const employeeMap: EmployeeMapRule[] = fullEmployeeMap.filter((r) => r.entity === e);

    const built = buildJournal(rows, accountMap, employeeMap);
    allDrafts.push(...built.drafts.filter((d) => d.entity === e));
  }
  console.log(`Built ${allDrafts.length} pay-date draft(s) across ${POSTABLE_ENTITIES.length} entities.`);

  const { buildAccrual } = await import('../../src/lib/payroll/accrual');

  const entityDrafts = allDrafts.filter((d) => d.entity === entity);
  const accr = buildAccrual(entityDrafts, entity, m);
  console.log(`\n################ ACCRUAL — ${entity} ${monthArg} ################`);
  if (!accr) {
    console.log('  (no qualifying run — nothing to accrue this month)');
  } else {
    printDraft(accr.accrual);
    printDraft(accr.reversal);
  }

  // The manual ADMIN wage % allocation (buildAllocation) was retired 2026-07 in favor of the
  // revenue-rule month-end allocation — see scripts/payroll/eom-dryrun.ts.
  console.log(`\n################ ALLOCATION — ${monthArg} ################`);
  console.log('  (manual %-allocation dry-run retired; use scripts/payroll/eom-dryrun.ts)');

  console.log('\n(dry run — nothing posted)');

  const { getRdsPool } = await import('../../src/lib/rds');
  await getRdsPool().end();
}

void main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
