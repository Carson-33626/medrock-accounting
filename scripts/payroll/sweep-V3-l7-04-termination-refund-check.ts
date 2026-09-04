/**
 * READ-ONLY (books sweep V3 verification of L7-04). Checks whether any of the five TN
 * employees flagged in L7-04 (medical/dental/vision EE deduction taken on their literal
 * final paycheck) received a later refund / negative-deduction / off-cycle credit check,
 * with NO upper date bound (unlike the original L7 probe, which stopped at 2026-07-31).
 * Prints every payroll_history row for these five position_ids across all available dates.
 * Names + dollar amounts only.
 *
 *   npx tsx scripts/payroll/sweep-V3-l7-04-termination-refund-check.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { SensitiveRow } from '../../src/lib/payroll/types';

interface Row {
  position_id: string; name: string; status: string; pay_type: string; pay_group: string;
  pay_date: string; row_key: string; sensitive_encrypted: string;
}

const TARGET_IDS = ['000694', '000715', '000321', '000693', '000418'];

const toIso = (d: string): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d ?? '');
  return m ? `${m[3]}-${m[1]}-${m[2]}` : d;
};
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY missing');
  const pool = getRdsPool();

  const { rows } = await pool.query<Row>(
    `SELECT position_id, name, status, pay_type, pay_group, pay_date, row_key, sensitive_encrypted
     FROM source.payroll_history
     WHERE position_id = ANY($1::text[])
     ORDER BY position_id, pay_date`,
    [TARGET_IDS],
  );

  console.log(`===== All payroll_history rows for the 5 L7-04 position_ids, no date bound (${rows.length} rows) =====`);
  let currentPos = '';
  for (const r of rows) {
    const iso = toIso(r.pay_date);
    const entity = entityForPayGroup(r.pay_group ?? '');
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    const sum = (re: RegExp): number =>
      Object.entries(s).reduce((acc, [k, v]) => (re.test(k) && typeof v === 'number' ? acc + v : acc), 0);
    const medEe = sum(/^MEDICAL.* - EE/i);
    const denEe = sum(/^DENTAL.* - EE/i);
    const visEe = sum(/^VISION.* - EE/i);
    if (r.position_id !== currentPos) {
      currentPos = r.position_id;
      console.log(`\n--- ${r.name} (${r.position_id}) ---`);
    }
    console.log(
      `  ${iso}  ${(entity ?? '(non-QB)').padEnd(11)}  status=${(r.status ?? '').padEnd(11)} payType=${(r.pay_type ?? '').padEnd(12)}  medEe=${money(medEe)} denEe=${money(denEe)} visEe=${money(visEe)}`,
    );
  }

  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
