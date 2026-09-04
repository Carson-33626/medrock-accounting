/** READ-ONLY: track the "EE WH not correct in Payroll" / Aetna discrepancy line across all 2026 Aetna JEs. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface QbLine { Amount?: number; Description?: string; JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string } } }
interface JE { Id?: string; DocNumber?: string; TxnDate?: string; Line?: QbLine[] }
async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const entries = await qbQueryAll<JE>('MedRock FL' as never, 'JournalEntry', `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate ASC`);
  const aetna = entries.filter(e => /^Aetna\s*2026/i.test(e.DocNumber ?? ''));
  console.log(`Found ${aetna.length} "Aetna 2026.*" JEs`);
  let cumulative = 0;
  for (const je of aetna) {
    const hits = (je.Line ?? []).filter(l => /(discrepancy|not correct|EE WH)/i.test(l.Description ?? ''));
    for (const l of hits) {
      const d = l.JournalEntryLineDetail;
      const signed = d?.PostingType === 'Debit' ? (l.Amount ?? 0) : -(l.Amount ?? 0);
      cumulative += signed;
      console.log(`  ${je.TxnDate}  #${je.DocNumber}  ${d?.PostingType} ${(l.Amount ?? 0).toFixed(2)}  desc=${JSON.stringify(l.Description)}  cum=${cumulative.toFixed(2)}`);
    }
    if (hits.length === 0) console.log(`  ${je.TxnDate}  #${je.DocNumber}  (no discrepancy line found)`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
