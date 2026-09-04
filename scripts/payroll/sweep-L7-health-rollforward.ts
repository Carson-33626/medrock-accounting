/**
 * READ-ONLY (books sweep L7, accountant-scrutiny pass). Builds a real roll-forward of the
 * health-benefits slice of 2110/2115, per entity, per month, Dec 2025 - Jul 2026:
 *
 *   opening unrelieved health accrual
 *   + credits tagged credit_bucket='Health' from OUR posted payroll JEs (accounting.
 *     payroll_journal_lines, joined to payroll_journal_headers WHERE status='posted') — this is
 *     the ADP-sourced EE health withholding as it actually posted to the books, not a re-derivation
 *     from raw ADP columns, so this ties the "EE withheld" leg to an independent, already-posted
 *     source rather than to a fresh ADP read.
 *   - debits that relieve the health accrual: every "Accrued Payroll Liability" debit line on a
 *     manually-posted "Aetna 2026.MM" JE whose description matches an EE-contribution / discrepancy
 *     pattern (the accountant's monthly true-up)
 *   = closing unrelieved health accrual
 *
 * A month that does not roll to $0 (or to a small, explained residual) is a real break, with a
 * dollar delta and a direction (over/understated). Prints per-entity per-month roll-forward tables
 * plus the underlying line detail so the numbers can be checked by hand.
 *
 *   npx tsx scripts/payroll/sweep-L7-health-rollforward.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
const MONTHS = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

interface CreditRow { entity: string; pay_date: string; txn_date: string; posting_type: 'Debit' | 'Credit'; amount: string; account_name: string; memo: string | null }

interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string } };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; Line?: QbLine[] }

async function main(): Promise<void> {
  const pool = getRdsPool();

  // Our posted payroll JEs' Health-bucket credits (and any Health-bucket debits, e.g. reversals).
  const { rows: healthRows } = await pool.query<CreditRow>(
    `SELECT h.entity, h.pay_date::text AS pay_date, h.txn_date::text AS txn_date,
            l.posting_type, l.amount::text AS amount, l.account_name, l.memo
     FROM accounting.payroll_journal_headers h
     JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
     WHERE h.status = 'posted' AND l.credit_bucket = 'Health'
       AND h.txn_date >= '2025-12-01' AND h.txn_date <= '2026-07-31'
     ORDER BY h.entity, h.txn_date`,
  );
  console.log(`Our posted payroll-JE 'Health' bucket lines in window: ${healthRows.length}`);
  const distinctAccounts = new Set(healthRows.map((r) => r.account_name));
  console.log(`  distinct account_name values seen: ${[...distinctAccounts].join(' | ')}`);

  const healthByEntityMonth = new Map<Entity, Map<string, number>>();
  for (const r of healthRows) {
    const entity = r.entity as Entity;
    const mm = r.txn_date.slice(0, 7);
    const signed = r.posting_type === 'Credit' ? Number(r.amount) : -Number(r.amount);
    const m = healthByEntityMonth.get(entity) ?? new Map<string, number>();
    m.set(mm, (m.get(mm) ?? 0) + signed);
    healthByEntityMonth.set(entity, m);
  }

  // Aetna JE relief lines: every debit to an "Accrued Payroll Liability"-named account on an
  // "Aetna 2026.MM" JE, per entity per month. This is the manual true-up that is SUPPOSED to relieve
  // what payroll credited. TN's JE credits an intercompany "Due to" account instead of debiting
  // Accrued Payroll Liability directly for the FULL amount — its EE-contribution debit lines to
  // Accrued Payroll Liability are what actually relieves TN's own liability; the intercompany credit
  // is a separate leg (booked in the roll-forward as "billed to FL", not "relief").
  const reliefByEntityMonth = new Map<Entity, Map<string, number>>();
  const intercompanyByEntityMonth = new Map<Entity, Map<string, number>>();
  for (const entity of ENTITIES) {
    const jes = await qbQueryAll<QbTxn>(entity, 'JournalEntry', `WHERE TxnDate >= '2025-12-01' ORDER BY TxnDate ASC`);
    const aetnaJes = jes.filter((j) => /aetna\s*2026/i.test(j.DocNumber ?? ''));
    const relief = reliefByEntityMonth.get(entity) ?? new Map<string, number>();
    const inter = intercompanyByEntityMonth.get(entity) ?? new Map<string, number>();
    for (const je of aetnaJes) {
      const mm = (je.TxnDate ?? '').slice(0, 7);
      for (const l of je.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        const acct = d?.AccountRef?.name ?? '';
        const desc = l.Description ?? '';
        const amt = l.Amount ?? 0;
        if (/^accrued payroll liability$/i.test(acct)) {
          const signed = d?.PostingType === 'Debit' ? amt : -amt;
          relief.set(mm, (relief.get(mm) ?? 0) + signed);
        }
        if (/^due (to|from)/i.test(acct)) {
          const signed = d?.PostingType === 'Debit' ? amt : -amt; // Dr Due-from = FL billing out; Cr Due-to = TN/TX booking payable
          inter.set(mm, (inter.get(mm) ?? 0) + signed);
        }
      }
    }
    reliefByEntityMonth.set(entity, relief);
    intercompanyByEntityMonth.set(entity, inter);
  }

  console.log('\n===== Health-accrual roll-forward: opening + payroll-JE Health credits - Aetna-JE relief = closing (unrelieved balance) =====');
  console.log('Opening = 0.00 at 2025-11-30 (no prior-period data pulled; treat as the start of this roll, not a claim that 2115 itself opened at zero).');
  for (const entity of ENTITIES) {
    console.log(`\n--- ${entity} ---`);
    const health = healthByEntityMonth.get(entity) ?? new Map<string, number>();
    const relief = reliefByEntityMonth.get(entity) ?? new Map<string, number>();
    const inter = intercompanyByEntityMonth.get(entity) ?? new Map<string, number>();
    let running = 0;
    console.log('month     opening      +healthJE cr   -AetnaJE relief   =closing      intercompany Aetna-JE line');
    for (const mm of MONTHS) {
      const opening = running;
      const add = health.get(mm) ?? 0;
      const sub = relief.get(mm) ?? 0;
      running = opening + add - sub;
      const ic = inter.get(mm) ?? 0;
      console.log(
        `${mm}   ${money(opening).padStart(11)}   ${money(add).padStart(11)}   ${money(sub).padStart(11)}   ${money(running).padStart(11)}   ${ic !== 0 ? money(ic) : '-'}`,
      );
    }
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
