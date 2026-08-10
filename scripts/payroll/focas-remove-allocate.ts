/**
 * Removes the Allocate vocabulary from FOCAS QuickBooks.
 *
 * WHY: today's COA replication cloned MedRock FL's five `Allocate - *` classes and the
 * `% Allocation` department into FOCAS. That turned out to be a trap rather than a feature —
 * `fetchAllocationPool` iterates EOM_ENTITIES and never queries FOCAS (qb-pool.ts:141), so a
 * FOCAS transaction coded `Allocate - %` is silently stranded: not pooled, not split, and not
 * surfaced in "Needs attention" either. There is no warning path at all. Worse, `% Allocation`
 * became FOCAS's ONLY department, making it the path of least resistance for anyone coding in
 * that company. Barbara's 2026-08-06 rule is that FOCAS payroll does not apply to the location
 * split, so the vocabulary should not exist there. Carson, 2026-08-07: remove them.
 *
 * QuickBooks does not delete Classes or Departments — it deactivates them (Active=false), which
 * is reversible and preserves any history. FOCAS has posted nothing against these (they were
 * created hours ago), so there is nothing to orphan.
 *
 * DEFAULT IS A DRY RUN. Pass --apply.
 *   NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/payroll/focas-remove-allocate.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withRetry } from './qb-retry';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbNamed { Id: string; Name: string; Active?: boolean; SyncToken: string }

const APPLY = process.argv.includes('--apply');
const CLASSES = ['Allocate - %', 'Allocate - FL', 'Allocate - TN', 'Allocate - TX', 'Allocate - SplitX3'];
const DEPARTMENTS = ['% Allocation'];

async function main(): Promise<void> {
  const { qbQueryAll, qbPost } = await import('../../src/lib/quickbooks-multi');

  const classes = await withRetry('FOCAS Class', () =>
    qbQueryAll<QbNamed>('FOCAS', 'Class', 'WHERE Active = true'));
  const depts = await withRetry('FOCAS Department', () =>
    qbQueryAll<QbNamed>('FOCAS', 'Department', 'WHERE Active = true'));

  const killClasses = classes.filter((c) => CLASSES.includes(c.Name));
  const killDepts = depts.filter((d) => DEPARTMENTS.includes(d.Name));

  console.log(`\nFOCAS active classes: ${classes.length}, departments: ${depts.length}`);
  console.log(APPLY ? '\n*** APPLY — deactivating in FOCAS QuickBooks ***\n' : '\n--- DRY RUN ---\n');
  console.log(`  classes to deactivate (${killClasses.length}):`);
  for (const c of killClasses) console.log(`    - id=${c.Id} ${c.Name}`);
  console.log(`  departments to deactivate (${killDepts.length}):`);
  for (const d of killDepts) console.log(`    - id=${d.Id} ${d.Name}`);

  const untouched = [
    ...classes.filter((c) => !CLASSES.includes(c.Name)).map((c) => `class ${c.Name}`),
    ...depts.filter((d) => !DEPARTMENTS.includes(d.Name)).map((d) => `dept ${d.Name}`),
  ];
  console.log(`  left alone (${untouched.length}): ${untouched.join(', ') || '(none)'}`);

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply.');
    return;
  }

  let done = 0;
  let failed = 0;
  for (const c of killClasses) {
    try {
      await qbPost('FOCAS', 'class?minorversion=75', { Id: c.Id, SyncToken: c.SyncToken, Name: c.Name, Active: false, sparse: true });
      done += 1;
      console.log(`  deactivated class  ${c.Name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAILED class ${c.Name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const d of killDepts) {
    try {
      await qbPost('FOCAS', 'department?minorversion=75', { Id: d.Id, SyncToken: d.SyncToken, Name: d.Name, Active: false, sparse: true });
      done += 1;
      console.log(`  deactivated dept   ${d.Name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAILED dept ${d.Name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\nDone. deactivated=${done} failed=${failed}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
