/**
 * READ-ONLY: can the FL/TN/TX payroll account map actually be cloned onto FOCAS?
 *
 * "Clone the same accounts to FOCAS" (accounting meeting 2026-08-06) only works if FOCAS's
 * QuickBooks company really contains accounts with the SAME fully-qualified names. QBO rejects a
 * journal-entry line whose AccountRef does not exist in that company, so a name that is present in
 * MedRock FL but absent in FOCAS would produce a draft that silently fails at post time — the worst
 * possible failure mode, because it looks fine until someone tries to post.
 *
 * This prints, for every account name the seed would emit for FOCAS: present / MISSING, plus the
 * near-miss candidates so a renamed equivalent can be spotted by eye.
 *   npx tsx scripts/payroll/probe-focas-coa.ts
 * QB creds come from .env.vercel (the .env.local QB client id is wrong — see docs).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbAccount {
  Name?: string;
  FullyQualifiedName?: string;
  AcctNum?: string;
  AccountType?: string;
  Active?: boolean;
}
interface QbDepartment { Name?: string; FullyQualifiedName?: string; Active?: boolean }

/** Crude similarity for near-miss suggestions: shared lowercase word count. */
function similarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean));
  let hits = 0;
  for (const w of wa) if (wb.has(w)) hits += 1;
  return hits / Math.max(wa.size, 1);
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../../src/lib/quickbooks-multi');
  const { buildSeedAccountMap } = await import('./account-map-seed-data');

  // FOCAS's own seed is empty today, so score the DONOR's account-name set — that is exactly what
  // "clone the same accounts" means. FL is the most complete of the three.
  const donorRules = buildSeedAccountMap('MedRock FL');
  const wanted = [...new Set(donorRules.map((r) => r.accountName))].sort();

  const focasAccounts = await qbQueryAll<QbAccount>('FOCAS', 'Account', 'WHERE Active = true');
  const present = new Set(
    focasAccounts.map((a) => a.FullyQualifiedName ?? a.Name ?? '').filter(Boolean),
  );

  console.log(`\nFOCAS active accounts: ${present.size}`);
  console.log(`Account names the MedRock FL seed uses: ${wanted.length}\n`);

  const missing: string[] = [];
  for (const name of wanted) {
    if (present.has(name)) {
      console.log(`  OK       ${name}`);
    } else {
      missing.push(name);
      console.log(`  MISSING  ${name}`);
    }
  }

  console.log(`\n=== ${missing.length} of ${wanted.length} account names are MISSING from FOCAS ===`);
  for (const name of missing) {
    const near = [...present]
      .map((p) => ({ p, s: similarity(name, p) }))
      .filter((x) => x.s >= 0.34)
      .sort((a, b) => b.s - a.s)
      .slice(0, 4);
    console.log(`\n  ${name}`);
    if (near.length === 0) console.log('      (no similar account in FOCAS)');
    for (const n of near) console.log(`      candidate: ${n.p}`);
  }

  // Full FOCAS payroll-ish COA, so a human can pick replacements for anything missing.
  console.log('\n\n=== FOCAS payroll-relevant accounts (full list) ===');
  const payroll = focasAccounts
    .filter((a) => /payroll|wage|withhold|accrued|garnish|401k|worker|reimburs|salar|tax/i.test(a.FullyQualifiedName ?? a.Name ?? ''))
    .map((a) => `${(a.AcctNum ?? '----').padEnd(8)} ${(a.AccountType ?? '?').padEnd(22)} ${a.FullyQualifiedName ?? a.Name ?? '?'}`)
    .sort();
  for (const a of payroll) console.log(`  ${a}`);

  const depts = await qbQueryAll<QbDepartment>('FOCAS', 'Department', 'WHERE Active = true');
  console.log(`\n=== FOCAS departments (${depts.length}) ===`);
  for (const d of depts.map((x) => x.FullyQualifiedName ?? x.Name ?? '?').sort()) console.log(`  ${d}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
