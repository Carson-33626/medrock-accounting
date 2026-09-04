/** READ-ONLY sanity check: does BalanceSheet end_date actually change the result for MedRock FL? */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
async function main(): Promise<void> {
  const mod = await import('../src/lib/quickbooks-multi');
  const { getValidTokens } = mod as unknown as { getValidTokens: (l: never) => Promise<{ access_token: string; realm_id: string } | null> };
  const tokens = await getValidTokens('MedRock FL' as never);
  if (!tokens) { console.log('not connected'); return; }
  const QB_API_BASE = 'https://quickbooks.api.intuit.com/v3';
  for (const asOf of ['2020-01-01', '2025-06-30', '2026-08-26']) {
    const url = `${QB_API_BASE}/company/${tokens.realm_id}/reports/BalanceSheet?start_date=2020-01-01&end_date=${asOf}&accounting_method=Accrual&minorversion=75`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } });
    const body = await res.text();
    console.log(`\n=== end_date=${asOf}  status=${res.status} bodyLen=${body.length} ===`);
    console.log(body.slice(0, 600));
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
