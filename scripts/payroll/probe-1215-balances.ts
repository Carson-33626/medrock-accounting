/** READ-ONLY: current QB balance of 1215 Employee Advances + 2110 Payroll Withholdings per entity.
 *    npx tsx scripts/payroll/probe-1215-balances.ts */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

interface QbAccount { Name?: string; AcctNum?: string; CurrentBalance?: number }

async function main(): Promise<void> {
  for (const entity of ['MedRock FL', 'MedRock TN', 'MedRock TX'] as Entity[]) {
    const accts = await qbQueryAll<QbAccount>(entity, 'Account', `WHERE Active = true`);
    for (const num of ['1215', '2110']) {
      const a = accts.find((x) => x.AcctNum === num);
      console.log(`${entity}  ${num} ${a?.Name ?? '?'}: ${a?.CurrentBalance?.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) ?? '?'}`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
