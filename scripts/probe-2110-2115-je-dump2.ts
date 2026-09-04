/** READ-ONLY: dump full raw line detail for recent/representative FL payroll+Aetna JEs. */
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

const WANT = ['PR 2026.08.14B', 'PR 2026.07.31', 'Aetna 2026.07', 'Aetna 2026.08', 'Aetna 2026.03'];

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const entries = await qbQueryAll<JE>('MedRock FL' as never, 'JournalEntry', `WHERE TxnDate >= '2026-01-01'`);
  for (const doc of WANT) {
    const je = entries.find((e) => e.DocNumber === doc);
    console.log(`\n===== MedRock FL  #${doc} =====`);
    if (!je) { console.log('  NOT FOUND — searching similar DocNumbers...'); 
      const similar = entries.filter(e => (e.DocNumber ?? '').includes(doc.split(' ')[0]));
      console.log('  candidates:', similar.map(e => e.DocNumber).slice(0,20));
      continue; }
    console.log(`  Date: ${je.TxnDate}   Id: ${je.Id}`);
    let dr = 0, cr = 0;
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      const type = d?.PostingType ?? '?';
      const amt = l.Amount ?? 0;
      if (type === 'Debit') dr += amt; else cr += amt;
      const acct = d?.AccountRef?.name ?? d?.AccountRef?.value ?? '?';
      console.log(`   ${type.padEnd(6)} ${amt.toFixed(2).padStart(12)}  ${acct.padEnd(45)}  desc=${JSON.stringify(l.Description ?? '')}`);
    }
    console.log(`   TOTALS  Dr ${dr.toFixed(2)}  Cr ${cr.toFixed(2)}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
