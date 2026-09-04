/** READ-ONLY: does an Aetna bill-recognition JE exist for May-Aug 2026 under any naming? */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface QbLine { Amount?: number; Description?: string }
interface JE { Id?: string; DocNumber?: string; TxnDate?: string; Line?: QbLine[] }
async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const entries = await qbQueryAll<JE>('MedRock FL' as never, 'JournalEntry', `WHERE TxnDate >= '2026-04-15' AND TxnDate <= '2026-08-27' ORDER BY TxnDate ASC`);
  const aetnaLike = entries.filter(e => /aetna/i.test(e.DocNumber ?? '') || (e.Line ?? []).some(l => /aetna/i.test(l.Description ?? '')));
  console.log(`Found ${aetnaLike.length} FL JEs mentioning "aetna" (DocNumber or line desc), 04/15-08/27/2026`);
  for (const e of aetnaLike) console.log(`  ${e.TxnDate}  #${e.DocNumber}  Id=${e.Id}  lines=${(e.Line ?? []).length}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
