/**
 * READ-ONLY: what exactly are "Allocate %" and "Due to FL/TN/TX"?
 *
 * Carson, 2026-08-07: "we need to ensure 'due to FL/TN/TX' and 'allocate %' are also included if
 * those are tags or what". QuickBooks has three separate dimensioning concepts and they are NOT
 * interchangeable — an Account, a Department (QBO's "location" dimension) and a Class. Replicating
 * the wrong one into FOCAS would silently produce JE lines that carry no dimension at all, so this
 * establishes which is which BEFORE anything is created.
 *
 * Prints, per company: every Department, every Class, and every account whose name looks
 * inter-entity ("Due to/from") or allocation-related.
 *   NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/payroll/probe-dimensions-and-interentity.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withRetry } from './qb-retry';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import type { Location } from '../../src/lib/quickbooks-multi';

interface QbNamed { Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean }
interface QbAccount extends QbNamed { AccountType: string; AcctNum?: string }

const LOCATIONS: Location[] = ['MedRock FL', 'MedRock TN', 'MedRock TX', 'FOCAS'];

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../../src/lib/quickbooks-multi');

  for (const loc of LOCATIONS) {
    console.log(`\n================ ${loc} ================`);

    const depts = await withRetry(`${loc} Department`, () =>
      qbQueryAll<QbNamed>(loc, 'Department', 'WHERE Active = true'));
    console.log(`  DEPARTMENTS (${depts.length}):`);
    for (const d of depts.sort((a, b) => (a.FullyQualifiedName ?? a.Name).localeCompare(b.FullyQualifiedName ?? b.Name))) {
      console.log(`    id=${d.Id.padEnd(5)} ${d.FullyQualifiedName ?? d.Name}`);
    }

    const classes = await withRetry(`${loc} Class`, () =>
      qbQueryAll<QbNamed>(loc, 'Class', 'WHERE Active = true'));
    console.log(`  CLASSES (${classes.length}):`);
    for (const c of classes.sort((a, b) => (a.FullyQualifiedName ?? a.Name).localeCompare(b.FullyQualifiedName ?? b.Name))) {
      console.log(`    id=${c.Id.padEnd(5)} ${c.FullyQualifiedName ?? c.Name}`);
    }

    const accts = await withRetry(`${loc} Account`, () =>
      qbQueryAll<QbAccount>(loc, 'Account', 'WHERE Active = true'));
    const interEntity = accts
      .filter((a) => /due (to|from)|inter-?entity|allocat/i.test(a.FullyQualifiedName ?? a.Name))
      .map((a) => `${(a.AcctNum ?? '----').padEnd(8)} ${a.AccountType.padEnd(22)} ${a.FullyQualifiedName ?? a.Name}`)
      .sort();
    console.log(`  INTER-ENTITY / ALLOCATION ACCOUNTS (${interEntity.length}):`);
    for (const a of interEntity) console.log(`    ${a}`);
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
