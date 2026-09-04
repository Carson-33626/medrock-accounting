/** READ-ONLY: theme-categorized Accrued(Cr) vs Paid(Dr) totals on account 133, for 2025 and 2026-YTD (thru today). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const TARGET_ACCOUNT_ID = '133';
const TODAY = '2026-08-27';

interface AccountRef { value?: string; name?: string }
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: AccountRef };
  AccountBasedExpenseLineDetail?: { AccountRef?: AccountRef };
  DepositLineDetail?: { AccountRef?: AccountRef };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; EntityRef?: { name?: string }; PaymentType?: string; Line?: QbLine[] }
interface Row { date: string; type: string; doc: string; vendor: string; memo: string; debit: number; credit: number }

function theme(memo: string, vendor: string): string {
  const m = (memo + ' ' + vendor).toLowerCase();
  if (m.includes('salesforce')) return 'Salesforce';
  if (m.includes('property tax') || m.includes('hillsborough') || m.includes('ad valorem')) return 'Property Tax';
  if (
    m.includes('conference') || m.includes('trade conf') || m.includes('lockwood') || m.includes('mitchell') ||
    m.includes('booth') || m.includes('exhibit') || m.includes('altour') || m.includes('paypal') ||
    m.includes('epiphany') || m.includes('derm') || m.includes('fsdpa') || m.includes('aad ') ||
    m.includes('skin of color') || m.includes('sunrise') || m.includes('sociedad') || m.includes('ct np') ||
    m.includes('b12.io') || m.includes('partnership')
  ) return 'Trade Conferences';
  if (m.includes('rent expense') || m.includes('storage space')) return 'Rent/Storage (2024 orphan)';
  if (m.includes('association dues') || m.includes('mabany') || m.includes('hampton lakes')) return 'Association Dues';
  if (m.includes('physician') || m.includes('continuing education')) return "Physician's CE";
  if (m.includes('fraud')) return 'Fraud wash (net zero)';
  if (m.includes('stripe')) return 'Stripe rev accrual (net zero)';
  if (m.includes('allo') || m.includes('allocation')) return 'FL % Allocation';
  return 'Other/Unclassified';
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const rows: Row[] = [];
  const jes = await qbQueryAll<QbTxn>('MedRock FL' as never, 'JournalEntry', '');
  for (const je of jes) {
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      const isDebit = d.PostingType === 'Debit';
      rows.push({ type: 'JE', date: je.TxnDate ?? '', doc: je.DocNumber ?? '', vendor: '', memo: l.Description ?? je.PrivateNote ?? '', debit: isDebit ? amt : 0, credit: isDebit ? 0 : amt });
    }
  }
  const purchases = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Purchase', '');
  for (const p of purchases) {
    for (const l of p.Line ?? []) {
      const d = l.AccountBasedExpenseLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      rows.push({ type: `Purchase`, date: p.TxnDate ?? '', doc: p.DocNumber ?? '', vendor: p.EntityRef?.name ?? '', memo: l.Description ?? '', debit: amt < 0 ? 0 : Math.abs(amt), credit: amt < 0 ? Math.abs(amt) : 0 });
    }
  }
  const bills = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Bill', '');
  for (const b of bills) {
    for (const l of b.Line ?? []) {
      const d = l.AccountBasedExpenseLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      rows.push({ type: 'Bill', date: b.TxnDate ?? '', doc: b.DocNumber ?? '', vendor: b.EntityRef?.name ?? '', memo: l.Description ?? '', debit: amt < 0 ? 0 : Math.abs(amt), credit: amt < 0 ? Math.abs(amt) : 0 });
    }
  }
  const deposits = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Deposit', '');
  for (const dep of deposits) {
    for (const l of dep.Line ?? []) {
      const d = l.DepositLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      rows.push({ type: 'Deposit', date: dep.TxnDate ?? '', doc: dep.DocNumber ?? '', vendor: dep.EntityRef?.name ?? '', memo: l.Description ?? '', debit: 0, credit: amt });
    }
  }

  function summarize(label: string, filtered: Row[]): void {
    const byTheme = new Map<string, { dr: number; cr: number }>();
    for (const r of filtered) {
      const t = theme(r.memo, r.vendor);
      const cur = byTheme.get(t) ?? { dr: 0, cr: 0 };
      cur.dr += r.debit;
      cur.cr += r.credit;
      byTheme.set(t, cur);
    }
    console.log(`\n--- ${label} ---`);
    let totalDr = 0, totalCr = 0;
    for (const [t, v] of [...byTheme.entries()].sort((a, b) => b[1].cr + b[1].dr - (a[1].cr + a[1].dr))) {
      console.log(`  ${t.padEnd(28)} Accrued(Cr) ${v.cr.toFixed(2).padStart(12)}   Paid(Dr) ${v.dr.toFixed(2).padStart(12)}   Net(Cr-Dr) ${(v.cr - v.dr).toFixed(2).padStart(12)}`);
      totalDr += v.dr; totalCr += v.cr;
    }
    console.log(`  ${'TOTAL'.padEnd(28)} Accrued(Cr) ${totalCr.toFixed(2).padStart(12)}   Paid(Dr) ${totalDr.toFixed(2).padStart(12)}   Net(Cr-Dr) ${(totalCr - totalDr).toFixed(2).padStart(12)}`);
  }

  const r2024 = rows.filter((r) => r.date.startsWith('2024'));
  const r2025 = rows.filter((r) => r.date.startsWith('2025'));
  const r2026ytd = rows.filter((r) => r.date >= '2026-01-01' && r.date <= TODAY);
  const r2026future = rows.filter((r) => r.date > TODAY);

  summarize('2024 (opening carryforward build)', r2024);
  summarize('2025 FULL YEAR', r2025);
  summarize(`2026 YTD (thru ${TODAY})`, r2026ytd);
  summarize('2026 FUTURE-DATED (already posted in QB, after today)', r2026future);

  const sum = (arr: Row[]) => arr.reduce((s, r) => s + r.credit - r.debit, 0);
  const open2025 = sum(r2024);
  const end2025 = open2025 + sum(r2025);
  const end2026ytd = end2025 + sum(r2026ytd);
  const endAll = end2026ytd + sum(r2026future);
  console.log(`\n=== RUNNING BALANCE CHECKPOINTS ===`);
  console.log(`Opening 2025 (= end 2024):        ${open2025.toFixed(2)}`);
  console.log(`End 2025 / Opening 2026 (Kristi -13,481.51 expected): ${end2025.toFixed(2)}`);
  console.log(`End Q1 2026 (Kristi -25,949.27 expected, add Q1 rows only separately)`);
  console.log(`Balance AS OF TODAY ${TODAY}:      ${end2026ytd.toFixed(2)}`);
  console.log(`Balance incl future-dated rows:    ${endAll.toFixed(2)}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
