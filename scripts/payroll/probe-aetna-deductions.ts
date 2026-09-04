/**
 * READ-ONLY (Carson, 2026-09-02, working-doc "March Aetna Allocation"): for the six people Barbara
 * says had no premium withheld in March 2026 (Deshommes, Pinchin, Cortese, Joseph, Prestia, Ivey)
 * plus Linares (Jan 2026 termination credit $541.02), print per pay date the MEDICAL / DENTAL /
 * VISION EE deductions and the ER medical amount, Jan–Jun 2026, so we can say whether the
 * premiums were later collected. Decrypted values printed for these people only, not persisted.
 *
 *   npx tsx scripts/payroll/probe-aetna-deductions.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { SensitiveRow } from '../../src/lib/payroll/types';

interface Row { position_id: string; name: string; pay_group: string; pay_date: string; row_key: string; sensitive_encrypted: string }
const NAMES = ['deshommes', 'pinchin', 'cortese', 'joseph', 'prestia', 'ivey', 'linares'];

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY; if (!key) throw new Error('PAYROLL_ENC_KEY missing');
  const pool = getRdsPool();
  const where = NAMES.map((n) => `name ILIKE '%${n}%'`).join(' OR ');
  const { rows } = await pool.query<Row>(`SELECT position_id, name, pay_group, pay_date, row_key, sensitive_encrypted FROM source.payroll_history WHERE ${where}`);
  const toIso = (d: string): string => { const [m, dd, y] = d.split('/'); return `${y}-${m}-${dd}`; };
  const inWindow = rows.filter((r) => { const d = toIso(r.pay_date); return d >= '2025-12-01' && d <= '2026-06-30'; }).sort((a, b) => a.name.localeCompare(b.name) || toIso(a.pay_date).localeCompare(toIso(b.pay_date)));
  let cur = '';
  for (const r of inWindow) {
    const s = decryptSensitive(r.sensitive_encrypted, key) as unknown as Record<string, unknown>;
    const pick = (re: RegExp): string => Object.entries(s).filter(([k, v]) => re.test(k) && typeof v === 'number' && v !== 0).map(([k, v]) => `${k.replace(/ - EE PRE-TAX| - EE POST-TAX/, '').slice(0, 22)}=${(v as number).toFixed(2)}`).join(' ');
    if (cur !== r.name) { cur = r.name; console.log(`\n=== ${r.name} (${r.position_id}) ${entityForPayGroup(r.pay_group ?? '')} ===`); }
    console.log(`  ${r.pay_date}  gross=${String(s['GROSS PAY'] ?? '')}  EE: ${pick(/^(MEDICAL|DENTAL|VISION).* - EE/) || '(no medical/dental/vision EE deduction)'}   ER: ${pick(/^MEDICAL - ER/) || '-'}`);
  }
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
