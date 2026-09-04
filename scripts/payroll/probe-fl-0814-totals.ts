/**
 * READ-ONLY (Carson, 2026-09-02, working-doc "FL Account 2110"): FL pay-date totals from ADP for
 * Jul–Aug 2026 — net pay, EE taxes, ER taxes, garnishments — so the 8/14 payroll's expected bank
 * draws (wages ≈ net pay, taxes, garnishments) can be compared with what actually hit 1020 Truist.
 * Aggregates only; nothing per person is printed.
 *
 *   npx tsx scripts/payroll/probe-fl-0814-totals.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';

interface Row { pay_group: string; pay_date: string; sensitive_encrypted: string }

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY; if (!key) throw new Error('PAYROLL_ENC_KEY missing');
  const pool = getRdsPool();
  const { rows } = await pool.query<Row>(`SELECT pay_group, pay_date, sensitive_encrypted FROM source.payroll_history WHERE pay_date LIKE '%/2026' AND (pay_date LIKE '07/%' OR pay_date LIKE '08/%')`);
  const agg = new Map<string, { n: number; net: number; gross: number; eeTax: number; erTax: number; garn: number; k401: number }>();
  for (const r of rows) {
    if (entityForPayGroup(r.pay_group ?? '') !== 'MedRock FL') continue;
    const s = decryptSensitive(r.sensitive_encrypted, key) as unknown as Record<string, unknown>;
    const num = (k: string): number => typeof s[k] === 'number' ? (s[k] as number) : 0;
    const sumBy = (re: RegExp): number => Object.entries(s).filter(([k, v]) => re.test(k) && typeof v === 'number').reduce((a, [, v]) => a + (v as number), 0);
    const a = agg.get(r.pay_date) ?? { n: 0, net: 0, gross: 0, eeTax: 0, erTax: 0, garn: 0, k401: 0 };
    a.n++; a.net += num('NET PAY'); a.gross += num('GROSS PAY'); a.eeTax += num('TOTAL TAXES - EE'); a.erTax += num('TOTAL TAXES - ER');
    a.garn += sumBy(/garnish|child support|levy/i); a.k401 += sumBy(/401K.*(EE|ER)/i);
    agg.set(r.pay_date, a);
  }
  for (const [d, a] of [...agg].sort()) console.log(`  ${d}  rows=${String(a.n).padStart(3)}  gross $${a.gross.toFixed(2).padStart(11)}  NET $${a.net.toFixed(2).padStart(11)}  EE tax $${a.eeTax.toFixed(2).padStart(10)}  ER tax $${a.erTax.toFixed(2).padStart(10)}  (EE+ER $${(a.eeTax + a.erTax).toFixed(2)})  garnish $${a.garn.toFixed(2)}  401k $${a.k401.toFixed(2)}`);
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
