/**
 * READ-ONLY (books sweep L7, benefits vs deductions). ADP side of the three-way reconciliation:
 * for FL/TN/TX, Jan-Jul 2026, aggregate EE MEDICAL/DENTAL/VISION (pre+post tax) and ER MEDICAL/
 * DENTAL/VISION deductions per entity per month from source.payroll_history. Also flags, by
 * person, every 2026 pay check where status='Terminated' or pay_type='Final Pay' AND a medical/
 * dental/vision EE deduction was still taken that check (termination-credit candidates, the
 * Linares pattern, K09/K16) and every person whose FIRST-EVER medical deduction lands more than
 * one pay period after their first 2026 check (new-hire waiting-period candidates).
 * Names + dollar amounts only — no plan tier, dependents, or other PII is printed.
 *
 *   npx tsx scripts/payroll/sweep-L7-deductions-by-entity-month.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { Entity, SensitiveRow } from '../../src/lib/payroll/types';

interface Row {
  position_id: string; name: string; status: string; pay_type: string; pay_group: string;
  pay_date: string; row_key: string; sensitive_encrypted: string;
}

const toIso = (d: string): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d ?? '');
  return m ? `${m[3]}-${m[1]}-${m[2]}` : d;
};
const monthOf = (iso: string): string => iso.slice(0, 7);
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface MonthAgg { eeMed: number; eeDen: number; eeVis: number; erMed: number; erDen: number; erVis: number; checks: number }
function blankAgg(): MonthAgg { return { eeMed: 0, eeDen: 0, eeVis: 0, erMed: 0, erDen: 0, erVis: 0, checks: 0 }; }

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY missing');
  const pool = getRdsPool();

  const { rows } = await pool.query<Row>(
    `SELECT position_id, name, status, pay_type, pay_group, pay_date, row_key, sensitive_encrypted
     FROM source.payroll_history`,
  );

  // entity -> month -> agg
  const byEntityMonth = new Map<Entity, Map<string, MonthAgg>>();
  // position_id -> ordered list of {payDate, iso, entity, medEe, denEe, visEe, status, payType}
  interface PersonPoint { iso: string; entity: Entity | null; medEe: number; denEe: number; visEe: number; status: string; payType: string; name: string }
  const byPerson = new Map<string, PersonPoint[]>();

  for (const r of rows) {
    const iso = toIso(r.pay_date);
    const entity = entityForPayGroup(r.pay_group ?? '');
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    const sum = (re: RegExp): number =>
      Object.entries(s).reduce((acc, [k, v]) => (re.test(k) && typeof v === 'number' ? acc + v : acc), 0);
    const medEe = sum(/^MEDICAL.* - EE/i);
    const denEe = sum(/^DENTAL.* - EE/i);
    const visEe = sum(/^VISION.* - EE/i);
    const medEr = sum(/^MEDICAL.* - ER/i);
    const denEr = sum(/^DENTAL.* - ER/i);
    const visEr = sum(/^VISION.* - ER/i);

    if (iso >= '2026-01-01' && iso <= '2026-07-31' && entity) {
      const m = byEntityMonth.get(entity) ?? new Map<string, MonthAgg>();
      const mm = monthOf(iso);
      const agg = m.get(mm) ?? blankAgg();
      agg.eeMed += medEe; agg.eeDen += denEe; agg.eeVis += visEe;
      agg.erMed += medEr; agg.erDen += denEr; agg.erVis += visEr;
      agg.checks += 1;
      m.set(mm, agg);
      byEntityMonth.set(entity, m);
    }

    if (iso >= '2026-01-01' && iso <= '2026-07-31') {
      const list = byPerson.get(r.position_id) ?? [];
      list.push({ iso, entity, medEe, denEe, visEe, status: r.status, payType: r.pay_type, name: r.name });
      byPerson.set(r.position_id, list);
    }
  }

  console.log('===== L7 three-way (ADP side): EE + ER MEDICAL/DENTAL/VISION by entity by month, 2026 Jan-Jul =====');
  for (const [entity, months] of byEntityMonth) {
    console.log(`\n--- ${entity} ---`);
    console.log('month     checks   EE-medical   EE-dental   EE-vision   ER-medical   ER-dental   ER-vision');
    const sortedMonths = [...months.keys()].sort();
    for (const mm of sortedMonths) {
      const a = months.get(mm)!;
      console.log(
        `${mm}   ${String(a.checks).padStart(6)}   ${money(a.eeMed).padStart(10)}   ${money(a.eeDen).padStart(9)}   ${money(a.eeVis).padStart(9)}   ${money(a.erMed).padStart(10)}   ${money(a.erDen).padStart(9)}   ${money(a.erVis).padStart(9)}`,
      );
    }
  }

  console.log('\n===== Termination-credit candidates: medical/dental/vision EE deduction on a Terminated-status or Final-Pay check, 2026 =====');
  for (const [pos, list] of byPerson) {
    list.sort((a, b) => a.iso.localeCompare(b.iso));
    for (const p of list) {
      const totalEe = p.medEe + p.denEe + p.visEe;
      const isTermCheck = p.status === 'Terminated' || p.payType === 'Final Pay';
      if (isTermCheck && totalEe > 0) {
        console.log(
          `  ${p.iso}  ${p.name.padEnd(28)} (${pos})  ${(p.entity ?? '(non-QB)').padEnd(11)}  status=${p.status.padEnd(11)} payType=${p.payType.padEnd(11)}  medEe=${p.medEe.toFixed(2)} denEe=${p.denEe.toFixed(2)} visEe=${p.visEe.toFixed(2)}`,
        );
      }
    }
  }

  console.log('\n===== New-hire waiting-period candidates: first medical/dental/vision EE deduction is 2+ checks after first 2026 check, same person still active =====');
  for (const [pos, list] of byPerson) {
    list.sort((a, b) => a.iso.localeCompare(b.iso));
    if (list.length < 3) continue;
    const first = list[0];
    const firstDeductionIdx = list.findIndex((p) => p.medEe + p.denEe + p.visEe > 0);
    if (firstDeductionIdx >= 2) {
      const fd = list[firstDeductionIdx];
      console.log(
        `  ${first.name.padEnd(28)} (${pos})  ${(first.entity ?? '(non-QB)').padEnd(11)}  first check ${first.iso}, first deduction check #${firstDeductionIdx + 1} on ${fd.iso} (medEe=${fd.medEe.toFixed(2)} denEe=${fd.denEe.toFixed(2)} visEe=${fd.visEe.toFixed(2)})`,
      );
    }
  }

  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
