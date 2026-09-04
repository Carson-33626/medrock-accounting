/**
 * READ-ONLY (books sweep L7, rework after verifier V2's rejection of L7-02/L7-03). Builds the
 * four-column per-entity-per-month table the orchestrator asked for: ADP EE withheld, FL's
 * intercompany bill line to that entity, that entity's own recognition JE (Id/date/amount/account),
 * and the residual. Combines the ADP register (source.payroll_history) with a broad Aetna JE search
 * (matching "aetna" anywhere in DocNumber/PrivateNote/line Description — the pattern that catches
 * "Aetna 03.2026 Alloc"-style DocNumbers the narrow /aetna\s*2026/i regex misses) across all three
 * entities, Jan-Jul 2026. Names + amounts only.
 *
 *   npx tsx scripts/payroll/sweep-L7-rework-residual-table.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity, SensitiveRow } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

interface PayrollRow { position_id: string; pay_group: string; pay_date: string; sensitive_encrypted: string }
const toIso = (d: string): string => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d ?? ''); return m ? `${m[3]}-${m[1]}-${m[2]}` : d; };

interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string } };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbLine[] }

async function main(): Promise<void> {
  // ---- A. ADP EE withheld (medical+dental+vision), TN and TX, by month ----
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY missing');
  const pool = getRdsPool();
  const { rows } = await pool.query<PayrollRow>(
    `SELECT position_id, pay_group, pay_date, sensitive_encrypted FROM source.payroll_history`,
  );
  const adpEeByEntityMonth = new Map<Entity, Map<string, number>>();
  const adpErByEntityMonth = new Map<Entity, Map<string, number>>();
  for (const r of rows) {
    const iso = toIso(r.pay_date);
    if (iso < '2026-01-01' || iso > '2026-07-31') continue;
    const entity = entityForPayGroup(r.pay_group ?? '');
    if (!entity) continue;
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    const sum = (re: RegExp): number => Object.entries(s).reduce((acc, [k, v]) => (re.test(k) && typeof v === 'number' ? acc + v : acc), 0);
    const ee = sum(/^(MEDICAL|DENTAL|VISION).* - EE/i);
    const er = sum(/^(MEDICAL|DENTAL|VISION).* - ER/i);
    const mm = iso.slice(0, 7);
    const eeMap = adpEeByEntityMonth.get(entity) ?? new Map<string, number>();
    eeMap.set(mm, (eeMap.get(mm) ?? 0) + ee);
    adpEeByEntityMonth.set(entity, eeMap);
    const erMap = adpErByEntityMonth.get(entity) ?? new Map<string, number>();
    erMap.set(mm, (erMap.get(mm) ?? 0) + er);
    adpErByEntityMonth.set(entity, erMap);
  }

  // ---- B. broad Aetna JE search, all entities, all 2026 ----
  const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
  const aetnaJesByEntity = new Map<Entity, QbTxn[]>();
  for (const entity of ENTITIES) {
    const jes = await qbQueryAll<QbTxn>(entity, 'JournalEntry', `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate ASC`);
    const hits = jes.filter((j) => {
      const doc = (j.DocNumber ?? '').toLowerCase();
      const note = (j.PrivateNote ?? '').toLowerCase();
      const lineHit = (j.Line ?? []).some((l) => /aetna/i.test(l.Description ?? ''));
      return doc.includes('aetna') || note.includes('aetna') || lineHit;
    });
    aetnaJesByEntity.set(entity, hits);
  }

  // ---- C. FL's intercompany bill lines to TN/TX, by month, from FL's own Aetna JEs ----
  const flBillTo = new Map<Entity, Map<string, { total: number; ids: string[] }>>();
  for (const je of aetnaJesByEntity.get('MedRock FL') ?? []) {
    const mm = (je.TxnDate ?? '').slice(0, 7);
    for (const l of je.Line ?? []) {
      const acct = l.JournalEntryLineDetail?.AccountRef?.name ?? '';
      const target: Entity | null = /due (from|to) medrock tn/i.test(acct) ? 'MedRock TN' : /due (from|to) medrock tx/i.test(acct) ? 'MedRock TX' : null;
      if (!target) continue;
      const amt = l.Amount ?? 0;
      const m = flBillTo.get(target) ?? new Map<string, { total: number; ids: string[] }>();
      const rec = m.get(mm) ?? { total: 0, ids: [] };
      rec.total += amt;
      rec.ids.push(`#${je.DocNumber}(Id${je.Id})`);
      m.set(mm, rec);
      flBillTo.set(target, m);
    }
  }

  // ---- D. each entity's own recognition JE — net movement in "Due to Medrock Pharmacy%" per month ----
  for (const entity of ['MedRock TN', 'MedRock TX'] as Entity[]) {
    console.log(`\n\n===================== ${entity} =====================`);
    console.log('month     ADP-EE      ADP-ER      FL-bill(ids)                          own-JE(ids, net Due-to)              residual (FL bill - own JE)');
    const eeMap = adpEeByEntityMonth.get(entity) ?? new Map<string, number>();
    const erMap = adpErByEntityMonth.get(entity) ?? new Map<string, number>();
    const billMap = flBillTo.get(entity) ?? new Map<string, { total: number; ids: string[] }>();
    const ownJes = aetnaJesByEntity.get(entity) ?? [];
    for (const mm of MONTHS) {
      const ee = eeMap.get(mm) ?? 0;
      const er = erMap.get(mm) ?? 0;
      const bill = billMap.get(mm) ?? { total: 0, ids: [] };
      const monthJes = ownJes.filter((j) => (j.TxnDate ?? '').startsWith(mm));
      let ownNet = 0;
      const ownIds: string[] = [];
      for (const je of monthJes) {
        ownIds.push(`#${je.DocNumber}(Id${je.Id})`);
        for (const l of je.Line ?? []) {
          const acct = l.JournalEntryLineDetail?.AccountRef?.name ?? '';
          if (!/^due to medrock pharmacy/i.test(acct)) continue;
          const amt = l.Amount ?? 0;
          ownNet += l.JournalEntryLineDetail?.PostingType === 'Credit' ? amt : -amt;
        }
      }
      const residual = bill.total - ownNet;
      console.log(
        `${mm}   ${money(ee).padStart(10)}  ${money(er).padStart(10)}  ${money(bill.total).padStart(11)} ${bill.ids.join(',').padEnd(20)}  ${money(ownNet).padStart(11)} ${ownIds.join(',').padEnd(20)}  ${money(residual).padStart(11)}`,
      );
    }
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
