/** READ-ONLY: check for Amy's accrual+reversal pattern (ACC PR X.V2/V2R) in FL 2110/2115,
 * and search for "EE WH"/"discrepancy" language in FL Aetna JEs, per Amy's Drive workpapers context. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface QbLine { Amount?: number; Description?: string; JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { value?: string; name?: string } } }
interface JE { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbLine[] }

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  // Pull a wide window to see if ACC PR pattern ever existed in FL, plus full 2026 window for language search.
  const wide = await qbQueryAll<JE>('MedRock FL' as never, 'JournalEntry', `WHERE TxnDate >= '2024-01-01' AND TxnDate <= '2025-12-31' ORDER BY TxnDate ASC`);
  console.log(`Pulled ${wide.length} FL JEs, 2024-01-01 to 2025-12-31`);
  const accMatches = wide.filter(e => /^ACC\s*PR/i.test(e.DocNumber ?? ''));
  console.log(`\n===== FL JEs matching "ACC PR*" DocNumber pattern (2024-2025) =====`);
  console.log(`Count: ${accMatches.length}`);
  for (const e of accMatches.slice(0, 30)) {
    console.log(`  ${e.TxnDate}  #${e.DocNumber}  Id=${e.Id}  lines=${(e.Line ?? []).length}`);
  }
  if (accMatches.length > 30) console.log(`  ... and ${accMatches.length - 30} more`);

  // 2026 window: search for "EE WH", "discrepancy", "not correct" language anywhere in FL JEs
  const y2026 = await qbQueryAll<JE>('MedRock FL' as never, 'JournalEntry', `WHERE TxnDate >= '2025-12-15' AND TxnDate <= '2026-02-15' ORDER BY TxnDate ASC`);
  console.log(`\n===== FL JEs 2025-12-15..2026-02-15 with "EE WH"/"discrepancy"/"not correct" in PrivateNote or any line Description =====`);
  for (const je of y2026) {
    const noteHit = /(EE WH|discrepancy|not correct)/i.test(je.PrivateNote ?? '');
    const lineHits = (je.Line ?? []).filter(l => /(EE WH|discrepancy|not correct)/i.test(l.Description ?? ''));
    if (noteHit || lineHits.length > 0) {
      console.log(`\n  ${je.TxnDate}  #${je.DocNumber}  Id=${je.Id}`);
      if (noteHit) console.log(`    NOTE: ${JSON.stringify(je.PrivateNote)}`);
      for (const l of lineHits) {
        const d = l.JournalEntryLineDetail;
        console.log(`    LINE: ${d?.PostingType} ${(l.Amount ?? 0).toFixed(2)}  ${d?.AccountRef?.name}  desc=${JSON.stringify(l.Description)}`);
      }
    }
  }

  // Also does FL have ANY "ACC PR" pattern at all in 2026?
  const y2026Full = await qbQueryAll<JE>('MedRock FL' as never, 'JournalEntry', `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate ASC`);
  const acc2026 = y2026Full.filter(e => /^ACC\s*PR/i.test(e.DocNumber ?? ''));
  console.log(`\n===== FL "ACC PR*" JEs in 2026 (should show reversal pattern if continued) =====`);
  console.log(`Count: ${acc2026.length}`);
  for (const e of acc2026) console.log(`  ${e.TxnDate}  #${e.DocNumber}  Id=${e.Id}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
