/**
 * READ-ONLY: pull every MedRock FL JournalEntry from 2025-11-01 through today,
 * extract only the lines touching 2110 (Payroll Withholdings, Id=15) or
 * 2115 (Accrued Payroll Liability, Id=1150040014), and print a running ledger
 * for each account plus category buckets (medical/aetna/SIC/other) by month.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const ACCT_2110 = '15';
const ACCT_2115 = '1150040014';

interface QbLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: string;
    AccountRef?: { value?: string; name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
    Entity?: { EntityRef?: { name?: string } };
  };
}
interface JE {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  PrivateNote?: string;
  Line?: QbLine[];
}

interface LedgerRow {
  date: string;
  doc: string;
  id: string;
  note: string;
  postingType: string;
  amount: number; // signed: credit positive, debit negative (liability-natural)
  desc: string;
}

function signedAmount(postingType: string, amount: number): number {
  // Liability-natural: Credit increases the liability (+), Debit decreases it (-).
  return postingType === 'Credit' ? amount : -amount;
}

function isMedical(text: string): boolean {
  return /(medical|health|aetna)/i.test(text);
}
function isSic(text: string): boolean {
  return /\bsic\b/i.test(text);
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const entries = await qbQueryAll<JE>(
    'MedRock FL' as never,
    'JournalEntry',
    `WHERE TxnDate >= '2025-11-01' ORDER BY TxnDate ASC`,
  );
  console.log(`Total FL JEs pulled (>= 2025-11-01): ${entries.length}`);

  const rows2110: LedgerRow[] = [];
  const rows2115: LedgerRow[] = [];

  for (const je of entries) {
    const date = je.TxnDate ?? '';
    const doc = je.DocNumber ?? '';
    const id = je.Id ?? '';
    const note = je.PrivateNote ?? '';
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      if (!d) continue;
      const acct = d.AccountRef?.value;
      const postingType = d.PostingType ?? '?';
      const amount = l.Amount ?? 0;
      const desc = l.Description ?? '';
      const row: LedgerRow = { date, doc, id, note, postingType, amount: signedAmount(postingType, amount), desc };
      if (acct === ACCT_2110) rows2110.push(row);
      if (acct === ACCT_2115) rows2115.push(row);
    }
  }

  function printLedger(label: string, rows: LedgerRow[]): void {
    console.log(`\n===== ${label}: ${rows.length} lines, 2025-11-01 -> today =====`);
    let running = 0;
    for (const r of rows) {
      running += r.amount;
      const tag = isMedical(r.note) || isMedical(r.desc) ? '[MED]' : isSic(r.note) || isSic(r.desc) ? '[SIC]' : '';
      console.log(
        `  ${r.date}  #${r.doc.padEnd(20)} ${r.postingType.padEnd(6)} ${r.amount.toFixed(2).padStart(12)}  run=${running.toFixed(2).padStart(12)} ${tag}  ${r.note || r.desc}`,
      );
    }
    console.log(`  ENDING RUNNING TOTAL (from 2025-11-01 activity only, not true opening balance): ${running.toFixed(2)}`);
  }

  printLedger('2110 Payroll Withholdings', rows2110);
  printLedger('2115 Accrued Payroll Liability', rows2115);

  // Monthly medical crossover quantification for 2110, Jan 1 2026 -> today
  console.log(`\n===== 2110: medical-tagged CREDIT lines, 2026-01-01 -> today =====`);
  let medicalCreditTotal2110 = 0;
  let medicalDebitTotal2110 = 0;
  for (const r of rows2110) {
    if (r.date < '2026-01-01') continue;
    if (isMedical(r.note) || isMedical(r.desc)) {
      if (r.postingType === 'Credit') medicalCreditTotal2110 += r.amount;
      else medicalDebitTotal2110 += Math.abs(r.amount);
      console.log(`  ${r.date}  #${r.doc}  ${r.postingType}  ${r.amount.toFixed(2)}  ${r.note || r.desc}`);
    }
  }
  console.log(`  TOTAL medical CREDITS into 2110 (2026 YTD): ${medicalCreditTotal2110.toFixed(2)}`);
  console.log(`  TOTAL medical DEBITS relieving 2110 (2026 YTD): ${medicalDebitTotal2110.toFixed(2)}`);

  console.log(`\n===== 2115: medical/Aetna-tagged lines, 2026-01-01 -> today =====`);
  let medicalDebitTotal2115 = 0;
  let medicalCreditTotal2115 = 0;
  for (const r of rows2115) {
    if (r.date < '2026-01-01') continue;
    if (isMedical(r.note) || isMedical(r.desc)) {
      if (r.postingType === 'Debit') medicalDebitTotal2115 += Math.abs(r.amount);
      else medicalCreditTotal2115 += r.amount;
      console.log(`  ${r.date}  #${r.doc}  ${r.postingType}  ${r.amount.toFixed(2)}  ${r.note || r.desc}`);
    }
  }
  console.log(`  TOTAL medical DEBITS relieving 2115 (2026 YTD): ${medicalDebitTotal2115.toFixed(2)}`);
  console.log(`  TOTAL medical CREDITS into 2115 (2026 YTD): ${medicalCreditTotal2115.toFixed(2)}`);

  // Monthly running balance snapshot for both accounts (month-end cumulative from 2025-11-01)
  function monthlySnapshot(label: string, rows: LedgerRow[]): void {
    console.log(`\n===== ${label}: cumulative activity by month (from 2025-11-01, NOT true balance) =====`);
    const byMonth = new Map<string, number>();
    let running = 0;
    for (const r of rows) {
      running += r.amount;
      const month = r.date.slice(0, 7);
      byMonth.set(month, running);
    }
    for (const [month, bal] of byMonth) {
      console.log(`  ${month}: cumulative-from-11/1 = ${bal.toFixed(2)}`);
    }
  }
  monthlySnapshot('2110', rows2110);
  monthlySnapshot('2115', rows2115);

  // December 2025 detail (opening balance decomposition)
  console.log(`\n===== 2110: ALL December 2025 + first 10 days of Jan 2026 activity (opening-balance decomposition) =====`);
  for (const r of rows2110) {
    if (r.date >= '2025-12-01' && r.date <= '2026-01-10') {
      console.log(`  ${r.date}  #${r.doc.padEnd(20)} ${r.postingType.padEnd(6)} ${r.amount.toFixed(2).padStart(12)}  ${r.note || r.desc}`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
