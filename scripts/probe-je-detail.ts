/** READ-ONLY: dump full line detail for specific JEs by DocNumber, per company. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: string;
    AccountRef?: { value?: string; name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
  };
}
interface JE { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbLine[] }

// [location, docNumber, creditOnly?]
const WANT: Array<[string, string, boolean]> = [
  ['MedRock TN', 'PR 2026.03.27', true],   // liability/credit side
  ['MedRock TX', 'PR 2026.03.13', false],  // full small TX entry
  ['MedRock FL', 'PR 2026.02.13 IE', false], // inter-entity companion
];

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  for (const [location, doc, creditOnly] of WANT) {
    const entries = await qbQueryAll<JE>(location as never, 'JournalEntry', `WHERE TxnDate >= '2026-01-01'`);
    const je = entries.find((e) => e.DocNumber === doc);
    console.log(`\n===== ${location}  #${doc} ${creditOnly ? '(CREDIT lines only)' : '(all lines)'} =====`);
    if (!je) { console.log('  NOT FOUND'); continue; }
    console.log(`  Note: ${je.PrivateNote ?? ''}`);
    let dr = 0, cr = 0;
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      const type = d?.PostingType ?? '?';
      const amt = l.Amount ?? 0;
      if (type === 'Debit') dr += amt; else cr += amt;
      if (creditOnly && type !== 'Credit') continue;
      const acct = d?.AccountRef?.name ?? d?.AccountRef?.value ?? '?';
      const cls = d?.ClassRef?.name ? ` [class:${d.ClassRef.name}]` : '';
      const dept = d?.DepartmentRef?.name ? ` [dept:${d.DepartmentRef.name}]` : '';
      console.log(`   ${type.padEnd(6)} ${amt.toFixed(2).padStart(12)}  ${acct}${cls}${dept}  ${l.Description ? '— ' + l.Description : ''}`);
    }
    console.log(`   TOTALS  Dr ${dr.toFixed(2)}  Cr ${cr.toFixed(2)}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
