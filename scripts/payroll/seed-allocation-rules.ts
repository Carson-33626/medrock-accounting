// Seeds the default ADMIN 1/3 allocation rule set for a REQUIRED go-live month (YYYY-MM-01).
//   npx tsx scripts/payroll/seed-allocation-rules.ts 2026-08-01
// Env from .env.local. BLOCKED on Barbara's go-live-month decision — do not run before then.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
async function main(): Promise<void> {
  const effectiveFrom = process.argv[2];
  if (!effectiveFrom || !/^\d{4}-\d{2}-01$/.test(effectiveFrom)) {
    throw new Error('pass the go-live month as YYYY-MM-01, e.g. 2026-08-01');
  }
  const { buildSeedAllocationRules } = await import('./allocation-rule-seed-data');
  const { saveAllocationRuleSet } = await import('../../src/lib/payroll/store');
  const rules = buildSeedAllocationRules(effectiveFrom);
  await saveAllocationRuleSet('ADMIN', effectiveFrom, rules);
  console.log(`seeded ADMIN allocation rules effective ${effectiveFrom}:`, rules.map((r) => `${r.targetEntity}=${r.percent}`).join(', '));
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
