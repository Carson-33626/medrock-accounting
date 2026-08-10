/**
 * READ-ONLY: isolate which QBO entity queries fetchDimensions() depends on actually succeed.
 * The EOM generate route calls fetchDimensions to pre-flight account names, and posting resolves
 * Department/Class refs through the same call — if Class/Department queries 403, both are blind.
 *   npx tsx scripts/payroll/probe-verify-dimension-fetch.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Entity } from '../../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface NameId { Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean }

async function main(): Promise<void> {
  const { qbQueryAll } = (await import('../../src/lib/quickbooks-multi')) as {
    qbQueryAll: <T>(location: string, entity: string, where: string) => Promise<T[]>;
  };
  const companies: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX', 'FOCAS'];
  for (const c of companies) {
    for (const ent of ['Account', 'Class', 'Department']) {
      try {
        const rows = await qbQueryAll<NameId>(c, ent, '');
        const alloc = rows.filter((r) => /allocat/i.test(r.FullyQualifiedName ?? r.Name));
        console.log(`${c.padEnd(14)} ${ent.padEnd(11)} OK  count=${String(rows.length).padStart(4)}  allocate-ish=${alloc.map((a) => `${a.FullyQualifiedName ?? a.Name}${a.Active === false ? ' (inactive)' : ''}`).join(' | ') || '-'}`);
      } catch (e) {
        console.log(`${c.padEnd(14)} ${ent.padEnd(11)} FAIL ${(e instanceof Error ? e.message : String(e)).slice(0, 140)}`);
      }
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
