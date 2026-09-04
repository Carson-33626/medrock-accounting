/**
 * READ-ONLY (books sweep L7, accountant-scrutiny pass). Extends probe-2110-2115-balance-trajectory.ts
 * (FL only) to all three entities: pulls the QB BalanceSheet (Accrual) report as-of each month-end,
 * Nov 2025 - Jul 2026, and extracts the 2110 / 2115 line balances directly from the report. This is
 * the authoritative whole-account roll-forward object (opening of month N = closing of month N-1,
 * by construction, since both come from the same report) — the health-only GL detail from
 * sweep-L7-qbo-health-ledger.ts is a components-of-change annotation on top of this, not a
 * substitute for it, since 2110/2115 also carry taxes, garnishments, net pay and WC (L2's scope).
 *
 *   npx tsx scripts/payroll/sweep-L7-balance-trajectory-all-entities.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

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
    if (nested && nested.length > 0) { collectLeaves(nested, out); continue; }
    const name = row.ColData?.[0]?.value?.trim();
    if (!name) continue;
    const raw = row.ColData?.[row.ColData.length - 1]?.value ?? '';
    const n = parseFloat(raw);
    out.push({ name, value: Number.isFinite(n) ? n : 0 });
  }
}

const DATES = ['2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31'];
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function main(): Promise<void> {
  const mod = await import('../../src/lib/quickbooks-multi');
  const { getValidTokens } = mod as unknown as { getValidTokens: (l: Entity) => Promise<{ access_token: string; realm_id: string } | null> };
  const QB_ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox';
  const QB_API_BASE = QB_ENVIRONMENT === 'production' ? 'https://quickbooks.api.intuit.com/v3' : 'https://sandbox-quickbooks.api.intuit.com/v3';

  for (const entity of ENTITIES) {
    console.log(`\n=== ${entity}: 2110 / 2115 month-end balances (from BalanceSheet report) ===`);
    const tokens = await getValidTokens(entity);
    if (!tokens) { console.log('  not connected'); continue; }
    let prev2110: number | null = null;
    let prev2115: number | null = null;
    for (const asOf of DATES) {
      const url = `${QB_API_BASE}/company/${tokens.realm_id}/reports/BalanceSheet?start_date=2020-01-01&end_date=${asOf}&accounting_method=Accrual&minorversion=75`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } });
      if (!res.ok) { console.log(`  ${asOf}: FAILED ${res.status}`); continue; }
      const report = (await res.json()) as QbBalanceSheetReport;
      const leaves: Array<{ name: string; value: number }> = [];
      collectLeaves(report.Rows?.Row ?? [], leaves);
      const l2110 = leaves.find((l) => l.name.startsWith('2110'));
      const l2115 = leaves.find((l) => l.name.startsWith('2115'));
      const v2110 = l2110?.value ?? NaN;
      const v2115 = l2115?.value ?? NaN;
      const d2110 = prev2110 !== null && Number.isFinite(v2110) ? v2110 - prev2110 : NaN;
      const d2115 = prev2115 !== null && Number.isFinite(v2115) ? v2115 - prev2115 : NaN;
      console.log(`  ${asOf}:  2110=${money(v2110).padStart(14)} (Δ ${Number.isFinite(d2110) ? money(d2110).padStart(12) : '  n/a'.padStart(12)})   2115=${money(v2115).padStart(14)} (Δ ${Number.isFinite(d2115) ? money(d2115).padStart(12) : '  n/a'.padStart(12)})`);
      prev2110 = Number.isFinite(v2110) ? v2110 : prev2110;
      prev2115 = Number.isFinite(v2115) ? v2115 : prev2115;
    }
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
