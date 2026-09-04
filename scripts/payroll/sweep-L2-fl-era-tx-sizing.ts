/**
 * READ-ONLY (books sweep L2, 2026-09-03), Q4 (K17 sizing): for the two positions that appear
 * under both MRFL and MRTX pay groups (found by sweep-L2-adp-summary.ts), aggregate their
 * FL-era (MRFL pay group) gross wages + EE/ER tax across their WHOLE FL-era history, so we can
 * size how much FL-borne, TX-belonging payroll cost never moved with them. No per-check amounts
 * printed — totals only, per position.
 *
 *   npx tsx scripts/payroll/sweep-L2-fl-era-tx-sizing.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import type { SensitiveRow } from '../../src/lib/payroll/types';

interface Row { position_id: string; name: string; pay_group: string; pay_date: string; sensitive_encrypted: string }
const MOVERS = ['000714', '000717'];

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY; if (!key) throw new Error('PAYROLL_ENC_KEY missing');
  const pool = getRdsPool();
  const { rows } = await pool.query<Row>(
    `SELECT position_id, name, pay_group, pay_date, sensitive_encrypted FROM source.payroll_history WHERE position_id = ANY($1::text[])`,
    [MOVERS],
  );
  for (const pos of MOVERS) {
    const flRows = rows.filter((r) => r.position_id === pos && r.pay_group === 'MRFL');
    let gross = 0, eeTax = 0, erTax = 0, dates = 0;
    for (const r of flRows) {
      const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
      const num = (k: string): number => (typeof s[k] === 'number' ? (s[k] as number) : 0);
      gross += num('GROSS PAY'); eeTax += num('TOTAL TAXES - EE'); erTax += num('TOTAL TAXES - ER'); dates++;
    }
    console.log(`position ${pos}: ${dates} MRFL pay dates, gross $${gross.toFixed(2)}, EE tax $${eeTax.toFixed(2)}, ER tax $${erTax.toFixed(2)} (EE+ER $${(eeTax + erTax).toFixed(2)}) — this is the FL-2110/2115-driving dollar volume that stayed on FL's books while under the FL pay group`);
  }
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
