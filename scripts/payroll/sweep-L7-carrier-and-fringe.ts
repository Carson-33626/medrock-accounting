/**
 * READ-ONLY (books sweep L7, benefits vs deductions). QBO side of the three-way reconciliation,
 * FL/TN/TX, 2026:
 *   A. Chart-of-accounts discovery: any account named like Aetna/Dental/Vision/Fringe/Benefit.
 *   B. Every JournalEntry with DocNumber matching /Aetna 2026/ (the monthly Aetna recognition JE
 *      Barbara posts) — confirms which months exist per entity, credit to 2115/2110, ER expense
 *      side, and any Due-from-TN/TX intercompany line.
 *   C. Every Bill/Purchase in 2026 where the vendor name matches Aetna/Delta Dental/VSP/Guardian/
 *      MetLife/Cigna/UnitedHealth/Humana/Principal (dental/vision/life carriers), so the actual
 *      carrier invoice total per entity per month can be compared to the JE and to ADP.
 *   D. Every JE/Bill/Purchase line touching a 'Fringe Benefit%' account in 2026, with memo, so we
 *      can size how much is really uncollected EE premium vs true fringe.
 *
 *   npx tsx scripts/payroll/sweep-L7-carrier-and-fringe.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
const CARRIER_RE = /aetna|delta\s*dental|\bvsp\b|guardian|metlife|cigna|unitedhealth|humana|principal|voya|reliance\s*standard/i;

interface QbAccount { Id?: string; Name?: string; AccountType?: string; CurrentBalance?: number }
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string; value?: string } };
  AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string; value?: string } };
}
interface QbTxn {
  Id?: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number; PrivateNote?: string;
  EntityRef?: { name?: string };
  Line?: QbLine[];
}

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    console.log(`\n\n========================= ${entity} =========================`);

    // A. account discovery
    const accounts = await qbQueryAll<QbAccount>(entity, 'Account', '');
    const relevant = accounts.filter((a) => /aetna|dental|vision|fringe|benefit/i.test(a.Name ?? ''));
    console.log('\n-- A. accounts matching aetna/dental/vision/fringe/benefit --');
    for (const a of relevant) console.log(`  ${(a.Name ?? '').padEnd(45)} type=${a.AccountType}  balance=${money(a.CurrentBalance ?? 0)}`);
    if (relevant.length === 0) console.log('  (none)');

    // B. Aetna 2026 JEs
    const jes = await qbQueryAll<QbTxn>(entity, 'JournalEntry', `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate ASC`);
    const aetnaJes = jes.filter((j) => /aetna\s*2026/i.test(j.DocNumber ?? ''));
    console.log(`\n-- B. "Aetna 2026.*" JEs found: ${aetnaJes.length} --`);
    for (const j of aetnaJes) {
      console.log(`  ${j.TxnDate}  #${j.DocNumber}  Id=${j.Id}`);
      for (const l of j.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        console.log(`      ${(d?.PostingType ?? '?').padEnd(6)} ${money(l.Amount ?? 0).padStart(12)}  ${(d?.AccountRef?.name ?? '?').padEnd(40)} desc=${JSON.stringify(l.Description ?? '')}`);
      }
    }
    for (const mm of ['01', '02', '03', '04', '05', '06', '07', '08']) {
      const found = aetnaJes.some((j) => j.DocNumber === `Aetna 2026.${mm}`);
      console.log(`  Aetna 2026.${mm}: ${found ? 'FOUND' : 'MISSING'}`);
    }

    // C. carrier bills/purchases 2026
    console.log('\n-- C. Bills/Purchases 2026 to carrier-matching vendors --');
    let carrierTotal = 0;
    for (const type of ['Bill', 'Purchase']) {
      const txns = await qbQueryAll<QbTxn>(entity, type, `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate ASC`);
      const hits = txns.filter((t) => CARRIER_RE.test(t.EntityRef?.name ?? ''));
      for (const t of hits) {
        carrierTotal += t.TotalAmt ?? 0;
        console.log(`  ${t.TxnDate}  ${type.padEnd(8)} ${(t.DocNumber ?? t.Id ?? '?').padEnd(16)} vendor=${t.EntityRef?.name}  total=${money(t.TotalAmt ?? 0)}`);
      }
      if (hits.length === 0) console.log(`  (no ${type} hits)`);
    }
    console.log(`  --- carrier Bill/Purchase total 2026: ${money(carrierTotal)}`);

    // D. Fringe Benefit account activity 2026
    console.log('\n-- D. Fringe Benefit account activity 2026 (JE + Bill + Purchase), with memo --');
    const fringeAccountNames = new Set(accounts.filter((a) => /fringe/i.test(a.Name ?? '')).map((a) => a.Name));
    if (fringeAccountNames.size === 0) {
      console.log('  no account matched /fringe/i by name — falling back to /6500\\.65|6500-65/ in account name');
    }
    let fringeTotal = 0;
    for (const type of ['JournalEntry', 'Bill', 'Purchase']) {
      const txns = await qbQueryAll<QbTxn>(entity, type, `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate ASC`);
      for (const t of txns) {
        for (const l of t.Line ?? []) {
          const jeAcct = l.JournalEntryLineDetail?.AccountRef?.name;
          const expAcct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
          const acctName = jeAcct ?? expAcct ?? '';
          const isFringe = fringeAccountNames.size > 0
            ? fringeAccountNames.has(acctName)
            : /fringe|6500[.\-]?65/i.test(acctName);
          if (!isFringe) continue;
          const amt = l.Amount ?? 0;
          fringeTotal += amt;
          console.log(`  ${t.TxnDate}  ${type.padEnd(12)} ${(t.DocNumber ?? t.Id ?? '?').padEnd(16)} ${money(amt).padStart(10)}  vendor=${t.EntityRef?.name ?? ''}  desc=${JSON.stringify(l.Description ?? t.PrivateNote ?? '')}`);
        }
      }
    }
    console.log(`  --- Fringe Benefit lines total 2026: ${money(fringeTotal)}`);
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
