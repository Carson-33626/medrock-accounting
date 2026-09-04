/**
 * READ-ONLY (Barbara via Carson, 2026-08-25): after finding Veronica Denha's $1,500 of
 * loan repayments stranded in 2110 instead of 1215, sweep for ANYONE ELSE hitting
 * Employee Advances that we overlooked.
 *
 *   A. ADP side — every person in source.payroll_history carrying an advance/loan
 *      repayment deduction (COMPANY LOAN / ADV DEDUCTION, 401K loans excluded — those are
 *      retirement-bucket by design). Per person: total withheld, span, and how much of it
 *      reached 1215 via OUR posted JEs (line account 'Employee Advances' whose
 *      source_row_keys carry that person's rows) vs ran through months we did not post
 *      (manual-JE months → credit likely stranded in 2110, same mechanism as Veronica).
 *   B. QB side — every line touching 'Employee Advances' in FL/TN/TX since 2025-01-01
 *      across JournalEntry, Purchase, Bill, Deposit: the full ledger of who fed 1215.
 *
 *   npx tsx scripts/payroll/probe-1215-sweep.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity, SensitiveRow } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const sortDate = (d: string): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : d;
};

const REPAYMENT_COLS = ['COMPANY LOAN - EE - PRINCIPAL POST-TAX', 'ADV DEDUCTION - EE - PRINCIPAL POST-TAX'];
const isOtherAdvanceLooking = (col: string): boolean =>
  /COMPANY LOAN|ADV DEDUCTION|ADVANCE/i.test(col) && !/401K|- TOTAL$/i.test(col) && !REPAYMENT_COLS.includes(col);

interface RawRow {
  position_id: string; name: string; pay_group: string; pay_date: string; row_key: string; sensitive_encrypted: string;
}
interface Withholding { payDate: string; entity: Entity | null; column: string; amount: number; rowKey: string }

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const pool = getRdsPool();

  // ---- A. ADP side ---------------------------------------------------------
  const { rows: raw } = await pool.query<RawRow>(
    `SELECT position_id, name, pay_group, pay_date, row_key, sensitive_encrypted FROM source.payroll_history`,
  );
  const byPerson = new Map<string, { name: string; items: Withholding[] }>();
  const otherCols = new Map<string, { total: number; people: Set<string> }>();
  for (const r of raw) {
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    for (const [col, val] of Object.entries(s)) {
      if (typeof val !== 'number' || val === 0) continue;
      if (isOtherAdvanceLooking(col)) {
        const o = otherCols.get(col) ?? { total: 0, people: new Set<string>() };
        o.total += val; o.people.add(`${r.name} (${r.position_id})`);
        otherCols.set(col, o);
      }
      if (!REPAYMENT_COLS.includes(col)) continue;
      const p = byPerson.get(r.position_id) ?? { name: r.name ?? '(no name)', items: [] };
      p.items.push({ payDate: r.pay_date ?? '(no date)', entity: entityForPayGroup(r.pay_group ?? ''), column: col, amount: val, rowKey: r.row_key });
      byPerson.set(r.position_id, p);
    }
  }

  console.log(`=== A. people with advance/loan repayment deductions — ${byPerson.size} ===`);
  for (const [pos, p] of [...byPerson].sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)))) {
    const total = p.items.reduce((s, i) => s + i.amount, 0);
    const rowKeys = p.items.map((i) => i.rowKey);

    // Which of their rows reached 1215 through OUR posted JEs?
    const { rows: covered } = await pool.query<{ row_key: string; qb_doc_number: string | null }>(
      `SELECT DISTINCT rk AS row_key, h.qb_doc_number
       FROM accounting.payroll_journal_headers h
       JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
       CROSS JOIN LATERAL unnest(l.source_row_keys) AS rk
       WHERE h.status = 'posted' AND l.account_name = 'Employee Advances' AND rk = ANY($1::text[])`,
      [rowKeys],
    );
    const coveredKeys = new Set(covered.map((c) => c.row_key));
    const reached = p.items.filter((i) => coveredKeys.has(i.rowKey));
    const stranded = p.items.filter((i) => !coveredKeys.has(i.rowKey));
    const reachedTotal = reached.reduce((s, i) => s + i.amount, 0);
    const strandedTotal = stranded.reduce((s, i) => s + i.amount, 0);

    const dates = p.items.map((i) => i.payDate).sort((a, b) => sortDate(a).localeCompare(sortDate(b)));
    const entities = [...new Set(p.items.map((i) => i.entity ?? '(non-QB pay group)'))];
    const cols = [...new Set(p.items.map((i) => i.column))];
    console.log(`\n  ${p.name} (${pos}) — ${entities.join(', ')}`);
    console.log(`    ${cols.join(' + ')}`);
    console.log(`    withheld ${money(total)} over ${p.items.length} checks, ${dates[0]} .. ${dates[dates.length - 1]}`);
    console.log(`    reached 1215 via our posted JEs: ${money(reachedTotal)} · NOT via our JEs: ${money(strandedTotal)}${strandedTotal > 0 ? '  ⚠️ verify these months in QB (manual-JE months credit 2110, like Veronica)' : ''}`);
    if (stranded.length > 0) {
      for (const i of stranded.sort((a, b) => sortDate(a.payDate).localeCompare(sortDate(b.payDate)))) {
        console.log(`      ${i.payDate}  ${money(i.amount).padStart(10)}  ${i.entity ?? '(non-QB)'}`);
      }
    }
  }
  console.log(`\n  other advance-looking columns (informational): ${otherCols.size === 0 ? '(none)' : ''}`);
  for (const [col, o] of otherCols) console.log(`    ${money(o.total).padStart(12)}  ${col}  — ${[...o.people].join(', ')}`);

  // ---- B. QB side ----------------------------------------------------------
  interface QbLineDetail { PostingType?: 'Debit' | 'Credit'; AccountRef?: { name?: string } }
  interface QbTxn {
    Id: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number;
    EntityRef?: { name?: string };
    Line?: {
      Amount?: number; Description?: string;
      JournalEntryLineDetail?: QbLineDetail;
      AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } };
      DepositLineDetail?: { AccountRef?: { name?: string } };
    }[];
  }
  const TYPES: { type: string; label: string }[] = [
    { type: 'JournalEntry', label: 'JE' },
    { type: 'Purchase', label: 'Purchase' },
    { type: 'Bill', label: 'Bill' },
    { type: 'Deposit', label: 'Deposit' },
  ];
  for (const entity of ['MedRock FL', 'MedRock TN', 'MedRock TX'] as Entity[]) {
    console.log(`\n=== B. ${entity}: every txn line touching 'Employee Advances' since 2025-01-01 ===`);
    let net = 0;
    let hits = 0;
    for (const { type, label } of TYPES) {
      const txns = await qbQueryAll<QbTxn>(entity, type, `WHERE TxnDate >= '2025-01-01'`);
      for (const t of txns.sort((a, b) => (a.TxnDate ?? '').localeCompare(b.TxnDate ?? ''))) {
        for (const l of t.Line ?? []) {
          const jeAcct = l.JournalEntryLineDetail?.AccountRef?.name;
          const expAcct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
          const depAcct = l.DepositLineDetail?.AccountRef?.name;
          const acct = jeAcct ?? expAcct ?? depAcct;
          if (!/^employee advances$/i.test(acct ?? '')) continue;
          hits++;
          // Non-JE conventions: Purchase/Bill lines are debits to the account; Deposit lines credits.
          const side: 'Dr' | 'Cr' = jeAcct !== undefined
            ? (l.JournalEntryLineDetail?.PostingType === 'Debit' ? 'Dr' : 'Cr')
            : depAcct !== undefined ? 'Cr' : 'Dr';
          const amt = l.Amount ?? 0;
          net += side === 'Dr' ? amt : -amt;
          const who = t.EntityRef?.name ? `  payee=${t.EntityRef.name}` : '';
          console.log(`  ${t.TxnDate}  ${label.padEnd(8)} ${(t.DocNumber ?? `(id ${t.Id})`).padEnd(22)} ${side} ${money(amt).padStart(11)}${who}  ${l.Description ?? ''}`);
        }
      }
    }
    if (hits === 0) console.log('  (none)');
    else console.log(`  --- net movement since 2025-01-01: ${money(net)} (Dr positive; NOTE: opening balance not included)`);
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
