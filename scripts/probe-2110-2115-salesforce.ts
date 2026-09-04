/** READ-ONLY: find the Salesforce Maps bill #36585337 ($10,458.75, 02/25/2026) and how it was paid. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface BillLine { Amount?: number; DetailType?: string; AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string; name?: string } } }
interface Bill { Id?: string; TxnDate?: string; DocNumber?: string; TotalAmt?: number; VendorRef?: { name?: string }; PrivateNote?: string; Line?: BillLine[] }
async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const bills = await qbQueryAll<Bill>('MedRock FL' as never, 'Bill', `WHERE TxnDate >= '2026-01-01'`);
  const match = bills.filter(b => (b.DocNumber ?? '').includes('36585337') || /salesforce/i.test(b.VendorRef?.name ?? '') || Math.abs((b.TotalAmt ?? 0) - 10458.75) < 0.02);
  console.log(`Found ${match.length} candidate bills`);
  for (const b of match) {
    console.log(`\n#${b.DocNumber}  ${b.TxnDate}  vendor=${b.VendorRef?.name}  total=${b.TotalAmt}`);
    for (const l of b.Line ?? []) {
      console.log(`   ${l.DetailType}  ${(l.Amount ?? 0).toFixed(2)}  acct=${l.AccountBasedExpenseLineDetail?.AccountRef?.name}`);
    }
  }

  interface PurchaseLine { Amount?: number; AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string; name?: string } } }
  interface Purchase { Id?: string; TxnDate?: string; DocNumber?: string; TotalAmt?: number; EntityRef?: { name?: string }; PrivateNote?: string; Line?: PurchaseLine[] }
  const purchases = await qbQueryAll<Purchase>('MedRock FL' as never, 'Purchase', `WHERE TxnDate >= '2026-01-01'`);
  const pmatch = purchases.filter(p => /salesforce/i.test(p.EntityRef?.name ?? '') || Math.abs((p.TotalAmt ?? 0) - 10458.75) < 0.02);
  console.log(`\nFound ${pmatch.length} candidate Purchase (Check/Expense) txns`);
  for (const p of pmatch) {
    console.log(`\n#${p.DocNumber ?? p.Id}  ${p.TxnDate}  payee=${p.EntityRef?.name}  total=${p.TotalAmt}  note=${JSON.stringify((p.PrivateNote ?? '').slice(0,150))}`);
    for (const l of p.Line ?? []) {
      console.log(`   ${(l.Amount ?? 0).toFixed(2)}  acct=${l.AccountBasedExpenseLineDetail?.AccountRef?.name}`);
    }
  }

  interface BpLine { Amount?: number }
  interface BillPayment { Id?: string; TxnDate?: string; DocNumber?: string; TotalAmt?: number; VendorRef?: { name?: string }; Line?: BpLine[] }
  const bps = await qbQueryAll<BillPayment>('MedRock FL' as never, 'BillPayment', `WHERE TxnDate >= '2026-01-01'`);
  const bpmatch = bps.filter(b => /salesforce/i.test(b.VendorRef?.name ?? '') || Math.abs((b.TotalAmt ?? 0) - 10458.75) < 0.02);
  console.log(`\nFound ${bpmatch.length} candidate BillPayment txns`);
  for (const b of bpmatch) console.log(`  #${b.DocNumber ?? b.Id}  ${b.TxnDate}  vendor=${b.VendorRef?.name}  total=${b.TotalAmt}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
