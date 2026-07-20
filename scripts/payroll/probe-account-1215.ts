/**
 * READ-ONLY: resolve QB account number 1215 to its real Name/FullyQualifiedName per
 * company, plus its AccountType/classification. Barbara (2026-07-20) asked that
 * `COMPANY LOAN - EE - PRINCIPAL POST-TAX` map to QBO 1215, but our account map
 * resolves by NAME, not number — so we need the name before seeding anything.
 * Also dumps nearby 12xx accounts + any loan/advance/receivable-looking account.
 *   npx tsx scripts/payroll/probe-account-1215.ts
 * QB creds from .env.vercel (the .env.local QB client id is wrong).
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
  AccountSubType?: string;
  Classification?: string;
  Active?: boolean;
}

function describe(a: QbAccount): string {
  return [
    `${(a.AcctNum ?? '----').padEnd(6)}`,
    `${a.FullyQualifiedName ?? a.Name ?? '?'}`,
    `[${a.Classification ?? '?'} / ${a.AccountType ?? '?'} / ${a.AccountSubType ?? '?'}]`,
  ].join('  ');
}

async function main(): Promise<void> {
  const { qbQueryAll, getConnectionStatus } = await import('../../src/lib/quickbooks-multi');
  const status = await getConnectionStatus();
  const locations = (Object.keys(status) as Array<keyof typeof status>).filter((l) => status[l]);

  for (const location of locations) {
    console.log(`\n================ ${location} ================`);
    const accts = await qbQueryAll<QbAccount>(location, 'Account', 'WHERE Active = true');

    const exact = accts.filter((a) => a.AcctNum === '1215');
    console.log(`\n  >>> AcctNum 1215 (${exact.length} match):`);
    for (const a of exact) console.log(`    ${describe(a)}`);
    if (exact.length === 0) console.log('    NONE — 1215 not found as an active account here.');

    const near = accts
      .filter((a) => /^12\d\d$/.test(a.AcctNum ?? ''))
      .sort((x, y) => (x.AcctNum ?? '').localeCompare(y.AcctNum ?? ''));
    console.log(`\n  12xx range (${near.length}):`);
    for (const a of near) console.log(`    ${describe(a)}`);

    const loanish = accts
      .filter((a) => /loan|advance|employee receivable|due from employee/i.test(a.FullyQualifiedName ?? a.Name ?? ''))
      .sort((x, y) => (x.AcctNum ?? '').localeCompare(y.AcctNum ?? ''));
    console.log(`\n  loan/advance-looking (${loanish.length}):`);
    for (const a of loanish) console.log(`    ${describe(a)}`);
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
