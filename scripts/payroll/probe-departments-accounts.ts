/**
 * READ-ONLY: list every active QB Department and the payroll-relevant Accounts
 * (COGS/Payroll Expense/Withholdings/Accrued) per company, so Scope 3/4/5
 * departmentalization can be designed against REAL QB dimension names. Prints
 * names only — no PII, no amounts.
 *   npx tsx scripts/payroll/probe-departments-accounts.ts
 * QB creds from .env.vercel (the .env.local QB client id is wrong).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbDepartment { Name?: string; FullyQualifiedName?: string; Active?: boolean }
interface QbAccount { Name?: string; FullyQualifiedName?: string; AcctNum?: string; Active?: boolean }

async function main(): Promise<void> {
  const { qbQueryAll, getConnectionStatus } = await import('../../src/lib/quickbooks-multi');
  const status = await getConnectionStatus();
  const locations = (Object.keys(status) as Array<keyof typeof status>).filter((l) => status[l]);

  for (const location of locations) {
    console.log(`\n================ ${location} ================`);

    const depts = await qbQueryAll<QbDepartment>(location, 'Department', 'WHERE Active = true');
    console.log(`\n  DEPARTMENTS (${depts.length}):`);
    for (const d of depts.map((x) => x.FullyQualifiedName ?? x.Name ?? '?').sort()) console.log(`    ${d}`);

    const accts = await qbQueryAll<QbAccount>(location, 'Account', 'WHERE Active = true');
    const payroll = accts
      .filter((a) => /payroll|wage|withhold|accrued|garnish|401k|worker|reimburs/i.test(a.FullyQualifiedName ?? a.Name ?? ''))
      .map((a) => `${(a.AcctNum ?? '----').padEnd(6)} ${a.FullyQualifiedName ?? a.Name ?? '?'}`)
      .sort();
    console.log(`\n  PAYROLL-RELEVANT ACCOUNTS (${payroll.length}):`);
    for (const a of payroll) console.log(`    ${a}`);

    const hasAccountingWages = accts.some((a) => /accounting wages/i.test(a.FullyQualifiedName ?? a.Name ?? ''));
    console.log(`\n  >>> 'Accounting Wages' account present: ${hasAccountingWages ? 'YES' : 'NO'}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
