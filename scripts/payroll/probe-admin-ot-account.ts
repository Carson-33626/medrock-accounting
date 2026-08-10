/**
 * READ-ONLY: does MedRock FL's QuickBooks actually contain the dedicated administrative
 * overtime account that a July 2026 mapping attempt pointed at?
 *
 * Context (meeting item #7, "overtime rules should have populated already"): two account-map
 * rules written 2026-07-20 target 'Payroll Expense -:Administrative - OT Wages', but their
 * cost_center was saved as '*admin' / '*Admin' — values resolveLine can never match — so they
 * have never fired. The rule that DOES fire sends ADMIN overtime to the regular
 * 'Payroll Expense -:Administrative Wages' instead. Before repairing them, confirm the intended
 * account is real in QBO, and show every OT-ish account per company so the right target for the
 * ACCOUN (accounting department) cost center can be chosen deliberately rather than guessed.
 *   NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/payroll/probe-admin-ot-account.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withRetry } from './qb-retry';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbAccount { Name?: string; FullyQualifiedName?: string; AcctNum?: string; Active?: boolean }

const LOOK_FOR = [
  'COGS - Payroll Expense:COGS - Lab OT Wages',
  'COGS - Payroll Expense:COGS - Pharmacists OT Wages',
  'COGS - Payroll Expense:COGS - R & D OT Wages',
  'Payroll Expense -:Administrative - OT Wages',
  'Payroll Expense -:Customer Service - OT Wages',
  'Payroll Expense -:Data Entry - OT Wages',
  'Payroll Expense -:Marketing - OT Wages',
  'Payroll Expense -:Shipping - OT Wages',
];

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../../src/lib/quickbooks-multi');

  for (const location of ['MedRock FL', 'MedRock TN', 'MedRock TX', 'FOCAS'] as const) {
    const accts = await withRetry(`${location} Account`, () =>
      qbQueryAll<QbAccount>(location, 'Account', 'WHERE Active = true'));
    const names = new Set(accts.map((a) => a.FullyQualifiedName ?? a.Name ?? '').filter(Boolean));

    console.log(`\n================ ${location} (${names.size} active accounts) ================`);
    for (const want of LOOK_FOR) {
      console.log(`  ${names.has(want) ? 'EXISTS ' : 'ABSENT '} ${want}`);
    }

    const ot = [...names].filter((n) => /\bOT\b|overtime/i.test(n)).sort();
    console.log(`  -- all overtime accounts (${ot.length}):`);
    for (const n of ot) console.log(`       ${n}`);

    const admin = [...names].filter((n) => /administrat|accounting/i.test(n)).sort();
    console.log(`  -- all administrative / accounting accounts (${admin.length}):`);
    for (const n of admin) console.log(`       ${n}`);
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
