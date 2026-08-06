/** READ-ONLY: list every "PR ..." payroll JE (DocNumber) per company to find the last one. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface JE { Id?: string; DocNumber?: string; TxnDate?: string; Line?: unknown[] }
async function main(): Promise<void> {
  const { qbQueryAll, getConnectionStatus } = await import('../src/lib/quickbooks-multi');
  const status = await getConnectionStatus();
  for (const location of (Object.keys(status) as Array<keyof typeof status>).filter((l) => status[l])) {
    const entries = await qbQueryAll<JE>(location, 'JournalEntry', `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate DESC`);
    const pr = entries
      .filter((e) => /^PR\s*20/i.test(e.DocNumber ?? ''))
      .sort((a, b) => (a.TxnDate ?? '').localeCompare(b.TxnDate ?? ''));
    console.log(`\n=== ${location}: ${pr.length} "PR" entries ===`);
    for (const e of pr) console.log(`   ${e.TxnDate}  #${e.DocNumber}  lines:${(e.Line ?? []).length}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
