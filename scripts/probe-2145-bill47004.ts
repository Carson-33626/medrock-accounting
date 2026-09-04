/** READ-ONLY: Bill 47004 detail — the bill that VendorCredit 47902 (miscoded to 2145) was applied against. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const bills = await qbQueryAll<Record<string, unknown>>('MedRock FL' as never, 'Bill', "WHERE TxnDate >= '2025-11-01' AND TxnDate <= '2026-01-05'");
  const b = bills.find((x) => x.Id === '47004');
  console.log(JSON.stringify(b, null, 2));
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
