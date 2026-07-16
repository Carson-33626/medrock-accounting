/**
 * READ-ONLY: list the inter-entity ("Due From/To") Accounts in each QB company, so the
 * Scope 7 admin-wage allocation can be designed against REAL account names. `buildJePayload`
 * resolves lines by exact FullyQualifiedName and throws on a miss, so the seed needs the
 * literal strings — not our guess at them.
 *
 * Prints account names/numbers/types only — no PII, no amounts, no writes.
 *   npx tsx scripts/payroll/probe-interentity-accounts.ts
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
  Active?: boolean;
}

/** Matches the inter-entity family however it's actually named: "Due From/To", "Intercompany", "I/C". */
const IE_PATTERN = /due\s*(from|to)|inter[-\s]?company|intercompany|\bi\/c\b|inter[-\s]?entity/i;

async function main(): Promise<void> {
  const { qbQueryAll, getConnectionStatus } = await import('../../src/lib/quickbooks-multi');
  const status = await getConnectionStatus();
  const locations = (Object.keys(status) as Array<keyof typeof status>).filter((l) => status[l]);

  console.log(`Connected companies: ${locations.join(', ') || '(none)'}`);

  for (const location of locations) {
    console.log(`\n================ ${location} ================`);

    const accts = await qbQueryAll<QbAccount>(location, 'Account', 'WHERE Active = true');
    const ie = accts
      .filter((a) => IE_PATTERN.test(a.FullyQualifiedName ?? a.Name ?? ''))
      .sort((a, b) => (a.FullyQualifiedName ?? '').localeCompare(b.FullyQualifiedName ?? ''));

    console.log(`\n  INTER-ENTITY ACCOUNTS (${ie.length} of ${accts.length} active):`);
    if (ie.length === 0) {
      console.log('    (none matched — widen IE_PATTERN or the family is named differently here)');
    }
    for (const a of ie) {
      const num = (a.AcctNum ?? '----').padEnd(6);
      const type = `${a.AccountType ?? '?'}${a.AccountSubType ? ` / ${a.AccountSubType}` : ''}`;
      console.log(`    ${num} ${a.FullyQualifiedName ?? a.Name ?? '?'}`);
      console.log(`           ${type}`);
    }

    // The allocation needs a counterpart naming the OTHER two entities specifically.
    for (const other of ['FL', 'TN', 'TX']) {
      const hits = ie.filter((a) => new RegExp(`\\b${other}\\b`, 'i').test(a.FullyQualifiedName ?? a.Name ?? ''));
      if (hits.length > 0) console.log(`\n  >>> counterpart naming "${other}": ${hits.map((h) => h.FullyQualifiedName ?? h.Name).join(' | ')}`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
