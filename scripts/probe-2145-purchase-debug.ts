/** READ-ONLY: debug why DocNumber lookup for Purchase entities came back empty. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const LOC = 'MedRock FL' as never;
  const purchases = await qbQueryAll<Record<string, unknown>>(LOC, 'Purchase', "WHERE TxnDate >= '2025-12-01'");
  console.log('count:', purchases.length);
  for (const p of purchases.slice(0, 5)) {
    console.log(JSON.stringify({ Id: p.Id, DocNumber: p.DocNumber, TxnDate: p.TxnDate, TotalAmt: p.TotalAmt }, null, 2));
  }
  // Find by amount 1101.33 instead of DocNumber
  const hit = purchases.find((p) => Math.abs((p.TotalAmt as number) - 1101.33) < 0.01);
  console.log('\n--- Full detail for a 1101.33 Purchase ---');
  console.log(JSON.stringify(hit, null, 2));
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
