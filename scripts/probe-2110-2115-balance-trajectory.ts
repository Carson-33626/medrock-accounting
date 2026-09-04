/**
 * READ-ONLY: pull QB BalanceSheet (Accrual) as-of a series of month-end dates for MedRock FL
 * and extract the 2110 / 2115 line balances directly from the report, to get the authoritative
 * balance trajectory (rather than hand-summing JE + Purchase + Deposit activity).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbBsColData { value?: string; id?: string }
interface QbBsRow {
  Header?: { ColData?: QbBsColData[] };
  Rows?: { Row?: QbBsRow[] };
  Summary?: { ColData?: QbBsColData[] };
  ColData?: QbBsColData[];
}
interface QbBalanceSheetReport { Rows?: { Row?: QbBsRow[] } }

function collectLeaves(rows: QbBsRow[], out: Array<{ name: string; value: number }>): void {
  for (const row of rows) {
    const nested = row.Rows?.Row;
    if (nested && nested.length > 0) {
      collectLeaves(nested, out);
      continue;
    }
    const name = row.ColData?.[0]?.value?.trim();
    if (!name) continue;
    const raw = row.ColData?.[row.ColData.length - 1]?.value ?? '';
    const n = parseFloat(raw);
    out.push({ name, value: Number.isFinite(n) ? n : 0 });
  }
}

const DATES = [
  '2025-11-30',
  '2025-12-31',
  '2026-01-31',
  '2026-02-28',
  '2026-03-31',
  '2026-04-30',
  '2026-05-31',
  '2026-06-30',
  '2026-07-31',
  '2026-08-26',
];

async function main(): Promise<void> {
  const mod = await import('../src/lib/quickbooks-multi');
  const location = 'MedRock FL' as never;

  // There's no exported generic BalanceSheet fetcher, so hit the endpoint the same way
  // getBalanceSheetInventory does, via the internal qbRequest — reproduce minimally here.
  const { getValidTokens } = mod as unknown as { getValidTokens: (l: never) => Promise<{ access_token: string; realm_id: string } | null> };
  const tokens = await getValidTokens(location);
  if (!tokens) { console.log('FL not connected'); return; }

  const QB_ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox';
  const QB_API_BASE = QB_ENVIRONMENT === 'production' ? 'https://quickbooks.api.intuit.com/v3' : 'https://sandbox-quickbooks.api.intuit.com/v3';

  for (const asOf of DATES) {
    const url = `${QB_API_BASE}/company/${tokens.realm_id}/reports/BalanceSheet?start_date=2020-01-01&end_date=${asOf}&accounting_method=Accrual&minorversion=75`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } });
    if (!res.ok) { console.log(`${asOf}: FAILED ${res.status}`); continue; }
    const report = (await res.json()) as QbBalanceSheetReport;
    const leaves: Array<{ name: string; value: number }> = [];
    collectLeaves(report.Rows?.Row ?? [], leaves);
    const l2110 = leaves.find((l) => l.name.startsWith('2110'));
    const l2115 = leaves.find((l) => l.name.startsWith('2115'));
    console.log(`${asOf}:  2110=${(l2110?.value ?? NaN).toFixed(2).padStart(14)}   2115=${(l2115?.value ?? NaN).toFixed(2).padStart(14)}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
