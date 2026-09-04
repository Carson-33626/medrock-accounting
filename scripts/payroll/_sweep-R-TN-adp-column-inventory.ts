/** READ-ONLY: full inventory of every numeric column name found inside source.payroll_history's
 * decrypted sensitive blob, TN pay groups only, with an aggregate sum per column — used to find
 * which ADP columns feed 2020 Garnishment, 2025 PIA, 2116 Reimbursement, 2135 PTO liability.
 *   npx tsx scripts/payroll/_sweep-R-TN-adp-column-inventory.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { SensitiveRow } from '../../src/lib/payroll/types';

interface RawRow { position_id: string; name: string; pay_group: string; pay_date: string; row_key: string; sensitive_encrypted: string }

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const pool = getRdsPool();
  const { rows: raw } = await pool.query<RawRow>(
    `SELECT position_id, name, pay_group, pay_date, row_key, sensitive_encrypted FROM source.payroll_history`,
  );
  const colTotals = new Map<string, number>();
  const colTotalsTn = new Map<string, number>();
  for (const r of raw) {
    const entity = entityForPayGroup(r.pay_group ?? '');
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    for (const [col, val] of Object.entries(s)) {
      if (typeof val !== 'number' || val === 0) continue;
      colTotals.set(col, (colTotals.get(col) ?? 0) + val);
      if (entity === 'MedRock TN') colTotalsTn.set(col, (colTotalsTn.get(col) ?? 0) + val);
    }
  }
  console.log(`=== All columns, all entities (${colTotals.size} distinct) ===`);
  for (const [col, total] of [...colTotals].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${col} :: ${total.toFixed(2)}`);
  }
  console.log(`\n=== TN-only totals ===`);
  for (const [col, total] of [...colTotalsTn].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${col} :: ${total.toFixed(2)}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e); process.exit(1); });
