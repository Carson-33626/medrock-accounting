/**
 * READ-ONLY: dump the FULL line detail (all accounts, amounts, posting types) of Amy's
 * PR 2026.03.27 JE for FL and TN, plus the DISTINCT AccountRef.name set for each, so the
 * seed account map's account-name strings can be diffed against her real COA exactly.
 * No PII printed — account names, posting types, and dollar amounts only.
 *   npx tsx scripts/payroll/probe-full-je-accounts.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { value?: string; name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
  };
}
interface QbJournalEntry { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbLine[] }

const LOCATIONS = ['MedRock FL', 'MedRock TN'] as const;

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../../src/lib/quickbooks-multi');

  for (const location of LOCATIONS) {
    console.log(`\n================ ${location} — PR 2026.03.27 ================`);
    const entries = await qbQueryAll<QbJournalEntry>(location, 'JournalEntry', `WHERE DocNumber = 'PR 2026.03.27'`);
    const je = entries[0];
    if (!je) { console.log('  NOT FOUND'); continue; }
    console.log(`  Note: ${je.PrivateNote ?? ''}`);

    const accounts = new Set<string>();
    let dr = 0, cr = 0;
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      const type = d?.PostingType ?? '?';
      const amt = l.Amount ?? 0;
      if (type === 'Debit') dr += amt; else cr += amt;
      const acct = d?.AccountRef?.name ?? d?.AccountRef?.value ?? '?';
      accounts.add(acct);
      const cls = d?.ClassRef?.name ? ` [class:${d.ClassRef.name}]` : '';
      const dept = d?.DepartmentRef?.name ? ` [dept:${d.DepartmentRef.name}]` : '';
      console.log(`   ${type.padEnd(6)} ${amt.toFixed(2).padStart(12)}  ${acct}${cls}${dept}  ${l.Description ? '— ' + l.Description : ''}`);
    }
    console.log(`   TOTALS  Dr ${dr.toFixed(2)}  Cr ${cr.toFixed(2)}`);

    console.log(`\n  DISTINCT accounts (${accounts.size}):`);
    for (const a of [...accounts].sort()) console.log(`    ${a}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
