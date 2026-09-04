/** READ-ONLY: full line detail for the suspected-duplicate recurring 2011 accrual JEs, Apr-Sep 2026. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { value?: string; name?: string }; ClassRef?: { name?: string }; DepartmentRef?: { name?: string }; Entity?: { EntityRef?: { name?: string } } };
}
interface JE { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbLine[] }

const WANT = ['IE Adj 2026.03-8', 'IE Adj 2026.03-11', 'IE Adj 2026.03-12', 'IE Adj 2026.03-18', 'IE Adj 2026.03-21', 'IE Adj 2026.03-22', 'KTAS 03.26 05', 'KTAS 03.26 08', 'KTAS 03.26 09', 'KTAS 03.26 13', 'PR 2026.07.18', 'PR 2026.07.19', 'PR 2026.07.21', 'PR 2026.08.19B', 'PR 2026.08.20B'];

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const entries = await qbQueryAll<JE>('MedRock FL' as never, 'JournalEntry', "WHERE TxnDate >= '2026-01-01'");
  for (const doc of WANT) {
    const je = entries.find((e) => e.DocNumber === doc);
    console.log(`\n===== #${doc} =====`);
    if (!je) { console.log('  NOT FOUND'); continue; }
    console.log(`  Date: ${je.TxnDate}  Note: ${je.PrivateNote ?? ''}`);
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      const type = d?.PostingType ?? '?';
      const amt = l.Amount ?? 0;
      const acct = d?.AccountRef?.name ?? d?.AccountRef?.value ?? '?';
      const cls = d?.ClassRef?.name ? ` [class:${d.ClassRef.name}]` : '';
      const dept = d?.DepartmentRef?.name ? ` [dept:${d.DepartmentRef.name}]` : '';
      console.log(`   ${type.padEnd(6)} ${amt.toFixed(2).padStart(12)}  ${acct}${cls}${dept}  ${l.Description ? '— ' + l.Description : ''}`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
