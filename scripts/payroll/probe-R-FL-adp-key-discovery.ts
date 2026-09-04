/** READ-ONLY: discover ADP deduction/earning column names (inside the decrypted sensitive blob)
 * relevant to PTO, garnishment, reimbursement, and Puerto Rico payroll — across ALL rows, not a sample.
 *    npx tsx scripts/payroll/probe-R-FL-adp-key-discovery.ts */
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
    ['PTO/vacation/sick', /PTO|VACATION|SICK/i],
    ['Garnishment', /GARNISH/i],
    ['Reimburse', /REIMB/i],
    ['Puerto Rico / PR', /PUERTO|\bPR\b/i],
    ['401K', /401/i],
  ];
  for (const [label, re] of patterns) {
    const hits = [...allKeys].filter((k) => re.test(k)).sort();
    console.log(`\n[${label}] ${hits.length} matches:`);
    for (const h of hits) console.log(`  ${h}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
