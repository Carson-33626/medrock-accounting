/** READ-ONLY: check paid/unpaid status (Balance, LinkedTxn) of every Bill line hitting account 133 (2011). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const TARGET_ACCOUNT_ID = '133';

interface AccountRef { value?: string; name?: string }
interface QbLine {
  Amount?: number;
  Description?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: AccountRef };
}
interface LinkedTxn { TxnId?: string; TxnType?: string }
interface QbBill {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  EntityRef?: { name?: string };
  Line?: QbLine[];
  LinkedTxn?: LinkedTxn[];
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const bills = await qbQueryAll<QbBill>('MedRock FL' as never, 'Bill', "WHERE TxnDate >= '2025-01-01'");
  console.log('===== Bills touching account 133 (2011) — paid status =====');
  let unpaidTotalOn2011 = 0;
  for (const b of bills) {
    const hitLines = (b.Line ?? []).filter((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value === TARGET_ACCOUNT_ID);
    if (hitLines.length === 0) continue;
    const lineTotal = hitLines.reduce((s, l) => s + (l.Amount ?? 0), 0);
    const paidFraction = b.TotalAmt ? 1 - (b.Balance ?? 0) / b.TotalAmt : 1;
    const unpaidPortionOn2011 = lineTotal * (1 - paidFraction);
    unpaidTotalOn2011 += unpaidPortionOn2011;
    console.log(
      `Bill ${b.DocNumber ?? b.Id}  Date=${b.TxnDate}  Vendor=${b.EntityRef?.name}  TotalAmt=${b.TotalAmt}  Balance=${b.Balance}  2011-line-total=${lineTotal.toFixed(2)}  unpaidPortionOn2011=${unpaidPortionOn2011.toFixed(2)}`,
    );
    for (const lt of b.LinkedTxn ?? []) {
      console.log(`    LinkedTxn: ${lt.TxnType} ${lt.TxnId}`);
    }
  }
  console.log(`\nTotal currently-UNPAID bill amount sitting on 2011: ${unpaidTotalOn2011.toFixed(2)}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
