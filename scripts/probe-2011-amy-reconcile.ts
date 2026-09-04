/** READ-ONLY: reconcile Amy's $6,059.34 target vs actual -13,481.51 — pull full detail on the key 2025 one-off bills, the year-end zero-out JE, and 2026 Hillsborough payments. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface AccountRef { value?: string; name?: string }
interface QbLine {
  Amount?: number; Description?: string; DetailType?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: AccountRef };
  AccountBasedExpenseLineDetail?: { AccountRef?: AccountRef; ClassRef?: { name?: string } };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; TotalAmt?: number; EntityRef?: { name?: string }; Line?: QbLine[] }

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');

  console.log('===== "Trade Conf Adj 2025" full JE detail =====');
  const jes2025 = await qbQueryAll<QbTxn>('MedRock FL' as never, 'JournalEntry', "WHERE TxnDate >= '2025-01-01'");
  const zeroOut = jes2025.find((j) => j.DocNumber === 'Trade Conf Adj 2025');
  if (zeroOut) {
    console.log(`Date: ${zeroOut.TxnDate}  Note: ${zeroOut.PrivateNote ?? ''}`);
    for (const l of zeroOut.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      console.log(`  ${d?.PostingType?.padEnd(6)} ${(l.Amount ?? 0).toFixed(2).padStart(12)}  ${d?.AccountRef?.name ?? d?.AccountRef?.value}  ${l.Description ?? ''}`);
    }
  } else {
    console.log('NOT FOUND');
  }

  console.log('\n===== Full line detail for key 2025 one-off Bills (all lines, not just the 2011 line) =====');
  const bills = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Bill', "WHERE TxnDate >= '2025-01-01' AND TxnDate < '2026-01-01'");
  const wantDocs = ['P6010192', '033-NW25', '2025 - 012', '74582068-a55c-42a3-86', 'Partnership 2025-25'];
  for (const doc of wantDocs) {
    const b = bills.find((x) => x.DocNumber === doc);
    console.log(`\n-- Bill #${doc} --`);
    if (!b) { console.log('  NOT FOUND'); continue; }
    console.log(`  Date: ${b.TxnDate}  Total: ${b.TotalAmt}  Vendor: ${b.EntityRef?.name}`);
    for (const l of b.Line ?? []) {
      const d = l.AccountBasedExpenseLineDetail;
      if (!d) continue;
      console.log(`    Acct ${d.AccountRef?.value} "${d.AccountRef?.name}"  Amt=${l.Amount}  ${l.Description ?? ''}`);
    }
  }

  console.log('\n===== Purchases: Diversified Dermatology + Texas Dermatology (Aug 2025) full line detail =====');
  const purchases = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Purchase', "WHERE TxnDate >= '2025-08-01' AND TxnDate < '2025-09-01'");
  for (const p of purchases) {
    const vendor = (p.EntityRef?.name ?? '').toLowerCase();
    if (!vendor.includes('diversified') && !vendor.includes('texas dermatology') && !vendor.includes('sociedad')) continue;
    console.log(`\n-- ${p.DocNumber ?? p.Id}  ${p.TxnDate}  ${p.EntityRef?.name}  Total=${p.TotalAmt} --`);
    for (const l of p.Line ?? []) {
      const d = l.AccountBasedExpenseLineDetail;
      if (!d) continue;
      console.log(`    Acct ${d.AccountRef?.value} "${d.AccountRef?.name}"  Amt=${l.Amount}  ${l.Description ?? ''}`);
    }
  }

  console.log('\n===== ALL Hillsborough Tax Collector Purchases/Bills in 2026 (any account) =====');
  for (const entity of ['Purchase', 'Bill'] as const) {
    const items = await qbQueryAll<QbTxn>('MedRock FL' as never, entity, "WHERE TxnDate >= '2026-01-01'");
    const hits = items.filter((t) => (t.EntityRef?.name ?? '').toLowerCase().includes('hillsborough'));
    for (const t of hits) {
      console.log(`${entity} ${t.DocNumber ?? t.Id}  ${t.TxnDate}  Total=${t.TotalAmt}`);
      for (const l of t.Line ?? []) {
        const d = l.AccountBasedExpenseLineDetail;
        if (!d) continue;
        console.log(`    Acct ${d.AccountRef?.value} "${d.AccountRef?.name}"  Amt=${l.Amount}  ${l.Description ?? ''}`);
      }
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
