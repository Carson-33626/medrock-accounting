/** READ-ONLY: R-FL2 phase-2 follow-up discovery. QBO's own GL for FL 2020 Employee Garnishment
 * Liability shows the account is composed entirely of "Child Support" / "Child Support Fee"
 * payroll-JE lines, not "GARNISHMENT"/"CREDITOR GARNISHMENT" (the two terms R-FL's prior pass
 * searched for, which is why it found $0.00 cumulative garnishment activity). This probe widens
 * the ADP key search to CHILD SUPPORT, checks for a true PTO ACCRUAL/BALANCE column (distinct
 * from the usage-side PTO - EARNING / PTO CASHOUT - EARNING R-FL already found), and lists every
 * PR STATE key to settle 2117's open item on employer-side PR liabilities. Full population, all
 * source.payroll_history rows, not a sample.
 *    npx tsx scripts/payroll/sweep-R-FL2-key-discovery.ts */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import type { SensitiveRow } from '../../src/lib/payroll/types';

interface RawRow { sensitive_encrypted: string }

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const pool = getRdsPool();
  const { rows } = await pool.query<RawRow>(`SELECT sensitive_encrypted FROM source.payroll_history`);
  console.log(`Total rows: ${rows.length}`);

  const allKeys = new Set<string>();
  for (const r of rows) {
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    for (const k of Object.keys(s)) allKeys.add(k);
  }
  console.log(`Distinct keys across all rows: ${allKeys.size}`);

  const patterns: [string, RegExp][] = [
    ['Child support', /CHILD|SUPPORT/i],
    ['PTO accrual/balance (not usage)', /PTO.*(ACCRU|BAL|AVAIL|HOURS)/i],
    ['All PTO-adjacent', /PTO/i],
    ['Reimbursement (broader)', /REIMB/i],
    ['PR STATE (all)', /PR STATE/i],
  ];
  for (const [label, re] of patterns) {
    const hits = [...allKeys].filter((k) => re.test(k)).sort();
    console.log(`\n[${label}] ${hits.length} matches:`);
    for (const h of hits) console.log(`  ${h}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
