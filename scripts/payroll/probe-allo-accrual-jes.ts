/**
 * READ-ONLY: dump full line detail for Amy's percentage-allocation ("% Allo") and payroll-accrual
 * ("PR Accru") journal entries. These surfaced from probe-ie-usage.ts and are the direct precedent
 * for BOTH new scopes:
 *   - Scope 7 (admin wages split across FL/TN/TX) -> her "% Allo" JEs show the mechanism + her real
 *     percentages, vs our assumed 1/3.
 *   - Scope 6 (pay period spanning a month end)  -> "PR Accru 1/31/2026" suggests she accrued at
 *     month end rather than prorating one run into two JEs. Decides accrue-and-reverse vs prorate.
 *
 * Prints account names, memos, posting types, amounts. Employee names may appear in memos.
 *   npx tsx scripts/payroll/probe-allo-accrual-jes.ts
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
    AccountRef?: { name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
  };
}
interface QbJournalEntry { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbLine[] }

/** DocNumber substrings worth dumping in full, from the IE-usage probe. */
const OF_INTEREST = /%\s*allo|allo\b|accru|mktg allo/i;

async function main(): Promise<void> {
  const { qbQueryAll, getConnectionStatus } = await import('../../src/lib/quickbooks-multi');
  const status = await getConnectionStatus();
  const locations = (Object.keys(status) as Array<keyof typeof status>).filter((l) => status[l]);

  for (const location of locations) {
    console.log(`\n\n################ ${location} ################`);

    const entries = await qbQueryAll<QbJournalEntry>(
      location, 'JournalEntry', `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate`,
    );
    const hits = entries.filter((je) => OF_INTEREST.test(je.DocNumber ?? ''));

    if (hits.length === 0) { console.log('  (no allocation/accrual JEs)'); continue; }

    for (const je of hits) {
      console.log(`\n======== ${je.DocNumber}  (${je.TxnDate}) ========`);
      if (je.PrivateNote) console.log(`  Note: ${je.PrivateNote}`);

      let dr = 0, cr = 0;
      for (const l of je.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        const type = d?.PostingType ?? '?';
        const amt = l.Amount ?? 0;
        if (type === 'Debit') dr += amt; else cr += amt;
        const acct = d?.AccountRef?.name ?? '?';
        const cls = d?.ClassRef?.name ? ` [class:${d.ClassRef.name}]` : '';
        const dept = d?.DepartmentRef?.name ? ` [dept:${d.DepartmentRef.name}]` : '';
        console.log(`   ${type.padEnd(6)} ${amt.toFixed(2).padStart(12)}  ${acct}${cls}${dept}${l.Description ? `  — ${l.Description}` : ''}`);
      }
      console.log(`   ---- Dr ${dr.toFixed(2)}   Cr ${cr.toFixed(2)}   (${je.Line?.length ?? 0} lines)`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
