/** READ-ONLY: confirm exactly which Aetna bill-recognition JEs exist/are missing, Jan-Aug 2026. */
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
  for (const mm of ['01','02','03','04','05','06','07','08']) {
    const je = entries.find(e => e.DocNumber === `Aetna 2026.${mm}`);
    if (je) {
      const cr2115 = (je.Line ?? []).find(l => l.JournalEntryLineDetail?.PostingType === 'Credit' && /Accrued Payroll/i.test(l.JournalEntryLineDetail?.AccountRef?.name ?? ''));
      console.log(`Aetna 2026.${mm}: FOUND  Id=${je.Id}  date=${je.TxnDate}  2115-credit=${cr2115?.Amount?.toFixed(2) ?? 'n/a'}  totalLines=${(je.Line??[]).length}`);
    } else {
      console.log(`Aetna 2026.${mm}: MISSING`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
