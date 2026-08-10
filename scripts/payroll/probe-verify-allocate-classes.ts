/**
 * READ-ONLY: the full Allocate class vocabulary that actually exists in each QuickBooks company,
 * plus the Department list. Settles whether an "Allocate - FOCAS" class exists (i.e. whether
 * "allocate to FOCAS" is something an accountant can even code today) and whether every existing
 * Allocate class is one qb-pool.classifyAllocateFlag recognises.
 *   npx tsx scripts/payroll/probe-verify-allocate-classes.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyAllocateFlag } from '../../src/lib/payroll/qb-pool';
import type { Entity } from '../../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbClass { Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean }
interface QbDept { Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean }

const COMPANIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX', 'FOCAS'];

async function main(): Promise<void> {
  const { qbQueryAll } = (await import('../../src/lib/quickbooks-multi')) as {
    qbQueryAll: <T>(location: string, entity: string, where: string) => Promise<T[]>;
  };

  for (const company of COMPANIES) {
    console.log(`\n===== ${company} =====`);
    try {
      const classes = await qbQueryAll<QbClass>(company, 'Class', '');
      const alloc = classes.filter((c) => /allocat/i.test(c.FullyQualifiedName ?? c.Name));
      console.log(`  classes: ${classes.length} total, ${alloc.length} Allocate-ish`);
      for (const c of alloc.sort((a, b) => (a.FullyQualifiedName ?? a.Name).localeCompare(b.FullyQualifiedName ?? b.Name))) {
        const name = c.FullyQualifiedName ?? c.Name;
        const verdict = classifyAllocateFlag(name, null, company);
        console.log(`    ${name.padEnd(30)} active=${c.Active} -> ${verdict ? `rule=${verdict.rule} cp=${verdict.counterparty ?? '-'}` : 'NOT ALLOCATE-FLAGGED'}`);
      }
      const depts = await qbQueryAll<QbDept>(company, 'Department', '');
      const allocDept = depts.filter((d) => /allocat/i.test(d.FullyQualifiedName ?? d.Name));
      console.log(`  departments: ${depts.length} total; allocation-ish: ${allocDept.map((d) => `${d.FullyQualifiedName ?? d.Name} (active=${d.Active})`).join(', ') || '(none)'}`);
    } catch (e) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
