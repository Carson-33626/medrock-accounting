/**
 * READ-ONLY (Carson, 2026-09-02, working-doc item f): Audrey Freebeck's ADP history — every pay
 * date with every non-zero decrypted field, so the 11/25/2025 duplicate payment and the single
 * $1,862.28 PAYCORRECTIONDED recovery can be tied to the two TN journal entries (#15119, #15282)
 * that both credit 1215 for her. Decrypted values are printed for this one person only and not
 * persisted.
 *
 *   npx tsx scripts/payroll/probe-freebeck-adp.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { SensitiveRow } from '../../src/lib/payroll/types';

interface Row { position_id: string; name: string; pay_group: string; pay_date: string; row_key: string; sensitive_encrypted: string }

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY missing');
  const pool = getRdsPool();
  const { rows } = await pool.query<Row>(
    `SELECT position_id, name, pay_group, pay_date, row_key, sensitive_encrypted FROM source.payroll_history WHERE name ILIKE '%freebeck%' OR name ILIKE '%freeback%' ORDER BY pay_date`,
  );
  console.log(`${rows.length} payroll rows for Freebeck`);
  const toDate = (d: string): string => { const [m, dd, y] = d.split('/'); return `${y}-${m}-${dd}`; };
  const sorted = [...rows].sort((a, b) => toDate(a.pay_date).localeCompare(toDate(b.pay_date)));
  for (const r of sorted) {
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    const nonzero = Object.entries(s as Record<string, unknown>).filter(([, v]) => typeof v === 'number' ? v !== 0 : Boolean(v) && v !== '0' && v !== '0.00');
    console.log(`\n${r.pay_date}  ${r.name} (${r.position_id})  ${entityForPayGroup(r.pay_group ?? '')}  row_key=${r.row_key}`);
    for (const [k, v] of nonzero) console.log(`   ${k.padEnd(48)} ${String(v)}`);
  }
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
