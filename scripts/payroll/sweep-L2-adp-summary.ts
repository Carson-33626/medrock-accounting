/**
 * READ-ONLY (books sweep L2, 2026-09-03): per-entity, per-pay-date ADP aggregate totals
 * (gross, net, EE tax, ER tax, garnishments, 401k EE+ER) for Q4 2025 through today, so the
 * L2 summary can compare ADP totals to the payroll JE and the bank draws for every pay date.
 * Also lists "movers" (position appears under both MRFL and MRTX pay groups) with the
 * aggregate EE+ER tax dollars generated during their FL-era pay dates (K17 sizing) — no
 * per-person dollar amounts are printed, only person counts and aggregate totals, except
 * where a single named person is already a KNOWN-ISSUE subject (Oanh, K17).
 *
 *   npx tsx scripts/payroll/sweep-L2-adp-summary.ts
 */
import { writeFileSync } from 'node:fs';
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { Entity, SensitiveRow } from '../../src/lib/payroll/types';

interface Row { position_id: string; name: string; pay_group: string; pay_date: string; sensitive_encrypted: string }
interface PayDateAgg {
  n: number; gross: number; net: number; eeTax: number; erTax: number; garn: number; k401ee: number; k401er: number;
}
interface OutRow { entity: Entity; payDate: string; iso: string; agg: PayDateAgg }

const toIso = (d: string): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : d;
};

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY missing');
  const pool = getRdsPool();

  const { rows } = await pool.query<Row>(
    `SELECT position_id, name, pay_group, pay_date, sensitive_encrypted FROM source.payroll_history`,
  );

  const byEntityDate = new Map<string, PayDateAgg>();
  // For K17: track (entity, position) -> {first,last pay date} per pay_group so we can find movers.
  const groupsByPerson = new Map<string, Map<string, string[]>>();

  for (const r of rows) {
    const entity = entityForPayGroup(r.pay_group ?? '');
    const iso = toIso(r.pay_date);
    const byGroup = groupsByPerson.get(r.position_id) ?? new Map<string, string[]>();
    byGroup.set(r.pay_group ?? '(null)', [...(byGroup.get(r.pay_group ?? '(null)') ?? []), r.pay_date]);
    groupsByPerson.set(r.position_id, byGroup);

    if (!entity) continue;
    if (iso < '2025-10-01') continue; // Q4 2025 -> today

    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    const num = (k: string): number => (typeof s[k] === 'number' ? (s[k] as number) : 0);
    const sumBy = (re: RegExp): number =>
      Object.entries(s).filter(([k, v]) => re.test(k) && typeof v === 'number').reduce((a, [, v]) => a + (v as number), 0);

    const mapKey = `${entity}|${r.pay_date}`;
    const a: PayDateAgg = byEntityDate.get(mapKey) ?? { n: 0, gross: 0, net: 0, eeTax: 0, erTax: 0, garn: 0, k401ee: 0, k401er: 0 };
    a.n++;
    a.gross += num('GROSS PAY');
    a.net += num('NET PAY');
    a.eeTax += num('TOTAL TAXES - EE');
    a.erTax += num('TOTAL TAXES - ER');
    a.garn += sumBy(/garnish|child support|levy/i);
    a.k401ee += sumBy(/401K.*EE/i);
    a.k401er += sumBy(/401K.*ER/i);
    byEntityDate.set(mapKey, a);
  }

  const out: OutRow[] = [];
  console.log('=== Q1: ADP totals per entity per pay date, Q4 2025 -> today ===');
  for (const entity of ['MedRock FL', 'MedRock TN', 'MedRock TX'] as Entity[]) {
    console.log(`\n--- ${entity} ---`);
    const dates = [...byEntityDate].filter(([k]) => k.startsWith(`${entity}|`)).sort((a, b) => toIso(a[0].split('|')[1]).localeCompare(toIso(b[0].split('|')[1])));
    for (const [k, a] of dates) {
      const payDate = k.split('|')[1];
      out.push({ entity, payDate, iso: toIso(payDate), agg: a });
      console.log(`  ${payDate}  rows=${String(a.n).padStart(3)}  gross $${a.gross.toFixed(2).padStart(11)}  NET $${a.net.toFixed(2).padStart(11)}  EE tax $${a.eeTax.toFixed(2).padStart(10)}  ER tax $${a.erTax.toFixed(2).padStart(10)}  (EE+ER $${(a.eeTax + a.erTax).toFixed(2)})  garnish $${a.garn.toFixed(2)}  401k EE $${a.k401ee.toFixed(2)} ER $${a.k401er.toFixed(2)}`);
    }
  }

  console.log('\n=== Q4 (K17): pay groups per position, movers between MRFL and MRTX ===');
  const movers = [...groupsByPerson.entries()].filter(([, g]) => g.has('MRFL') && g.has('MRTX'));
  console.log(`  ${movers.length} position(s) appear under BOTH MRFL and MRTX pay groups (whole history)`);
  const sortDate = (d: string): string => toIso(d);
  for (const [pos, g] of movers) {
    const fl = (g.get('MRFL') ?? []).sort((a, b) => sortDate(a).localeCompare(sortDate(b)));
    const tx = (g.get('MRTX') ?? []).sort((a, b) => sortDate(a).localeCompare(sortDate(b)));
    console.log(`  position ${pos}: FL ${fl[0]}..${fl[fl.length - 1]} (${fl.length} dates)  TX ${tx[0]}..${tx[tx.length - 1]} (${tx.length} dates)`);
  }

  const outPath = 'C:/Users/Carson.D/AppData/Local/Temp/claude/C--Users-Carson-D-Documents-GitHub-Active-Development-Accounting-Analytics/6a486b3c-fdc7-4fb1-b5d1-161814adc246/scratchpad/L2/adp-summary.json';
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\ncached ${out.length} rows -> ${outPath}`);

  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
