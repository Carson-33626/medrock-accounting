/** READ-ONLY: candidate GL accounts for SIC - EARNING (marketing-team commission, per Carson
 *  2026-08-07). Lists every commission / marketing / bonus wage account per company so the
 *  mapping targets a real account rather than a guess. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withRetry } from './qb-retry';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface QbAccount { Name?: string; FullyQualifiedName?: string; AcctNum?: string }
async function main(): Promise<void> {
  const { qbQueryAll } = await import('../../src/lib/quickbooks-multi');
  for (const loc of ['MedRock FL', 'MedRock TN', 'MedRock TX'] as const) {
    const a = await withRetry(`${loc}`, () => qbQueryAll<QbAccount>(loc, 'Account', 'WHERE Active = true'));
    const hits = a
      .filter((x) => /commission|marketing|bonus|incentive|sic\b/i.test(x.FullyQualifiedName ?? x.Name ?? ''))
      .map((x) => `${(x.AcctNum ?? '----').padEnd(8)} ${x.FullyQualifiedName ?? x.Name}`)
      .sort();
    console.log(`\n=== ${loc} (${hits.length}) ===`);
    for (const h of hits) console.log(`  ${h}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
