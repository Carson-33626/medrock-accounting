/**
 * READ-ONLY: find the non-JE transactions (Purchase=Check/Expense, BillPayment, Deposit,
 * Transfer) that actually clear cash against 2110 / 2115 in MedRock FL. The JE-only ledger
 * balloons to +$2.3M cumulative because ADP's net-pay/tax/401k debits never show up as JE
 * lines — they must be bank-side Purchase/Check/Expense transactions coded to these accounts.
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

interface AccountBasedLine {
  Amount?: number;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string; name?: string } };
}
interface Purchase {
  Id?: string;
  TxnDate?: string;
  DocNumber?: string;
  PaymentType?: string;
  TotalAmt?: number;
  PrivateNote?: string;
  EntityRef?: { name?: string };
  AccountRef?: { value?: string; name?: string }; // the bank/CC account paid FROM
  Line?: AccountBasedLine[];
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');

  console.log('Pulling Purchase (Check/Expense) entities for MedRock FL, 2025-11-01 -> today...');
  const purchases = await qbQueryAll<Purchase>(
    'MedRock FL' as never,
    'Purchase',
    `WHERE TxnDate >= '2025-11-01' ORDER BY TxnDate ASC`,
  );
  console.log(`Total Purchase txns pulled: ${purchases.length}`);

  let count2110 = 0, count2115 = 0, sum2110 = 0, sum2115 = 0;
  for (const p of purchases) {
    for (const l of p.Line ?? []) {
      const acct = l.AccountBasedExpenseLineDetail?.AccountRef?.value;
      const amt = l.Amount ?? 0;
      if (acct === ACCT_2110) {
        count2110++; sum2110 += amt;
        console.log(`  [2110] ${p.TxnDate}  ${p.PaymentType ?? '?'}  #${p.DocNumber ?? p.Id}  payee=${p.EntityRef?.name ?? '?'}  bank=${p.AccountRef?.name ?? '?'}  amt=${amt.toFixed(2)}  note=${JSON.stringify((p.PrivateNote ?? '').slice(0, 100))}`);
      }
      if (acct === ACCT_2115) {
        count2115++; sum2115 += amt;
        console.log(`  [2115] ${p.TxnDate}  ${p.PaymentType ?? '?'}  #${p.DocNumber ?? p.Id}  payee=${p.EntityRef?.name ?? '?'}  bank=${p.AccountRef?.name ?? '?'}  amt=${amt.toFixed(2)}  note=${JSON.stringify((p.PrivateNote ?? '').slice(0, 100))}`);
      }
    }
  }
  console.log(`\nTOTAL Purchase lines hitting 2110: ${count2110}, sum=${sum2110.toFixed(2)}`);
  console.log(`TOTAL Purchase lines hitting 2115: ${count2115}, sum=${sum2115.toFixed(2)}`);

  // Also check BillPayment (Aetna bill paid via ACH would likely be a BillPayment if a Bill was entered)
  interface BpLine { Amount?: number; LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }> }
  interface BillPayment {
    Id?: string; TxnDate?: string; DocNumber?: string; TotalAmt?: number;
    PayType?: string; PrivateNote?: string; VendorRef?: { name?: string };
    CheckPayment?: { BankAccountRef?: { value?: string; name?: string } };
    CreditCardPayment?: { CCAccountRef?: { value?: string; name?: string } };
    Line?: BpLine[];
  }
  console.log('\nPulling BillPayment entities for MedRock FL, 2025-11-01 -> today...');
  const billPayments = await qbQueryAll<BillPayment>(
    'MedRock FL' as never,
    'BillPayment',
    `WHERE TxnDate >= '2025-11-01' ORDER BY TxnDate ASC`,
  );
  console.log(`Total BillPayment txns pulled: ${billPayments.length}`);
  for (const bp of billPayments) {
    const bankAcct = bp.CheckPayment?.BankAccountRef?.value ?? bp.CreditCardPayment?.CCAccountRef?.value;
    if (bankAcct === ACCT_2110 || bankAcct === ACCT_2115) {
      console.log(`  [${bankAcct === ACCT_2110 ? '2110' : '2115'} as PAY-FROM] ${bp.TxnDate}  #${bp.DocNumber ?? bp.Id}  vendor=${bp.VendorRef?.name}  amt=${(bp.TotalAmt ?? 0).toFixed(2)}`);
    }
  }

  // Also check Deposit and Transfer entities touching these accounts (in case Aetna is refunded, or PR clearing runs through a Deposit)
  interface DepositLine { Amount?: number; DepositLineDetail?: { AccountRef?: { value?: string; name?: string } } }
  interface Deposit { Id?: string; TxnDate?: string; DocNumber?: string; PrivateNote?: string; Line?: DepositLine[] }
  console.log('\nPulling Deposit entities for MedRock FL, 2025-11-01 -> today...');
  const deposits = await qbQueryAll<Deposit>('MedRock FL' as never, 'Deposit', `WHERE TxnDate >= '2025-11-01' ORDER BY TxnDate ASC`);
  console.log(`Total Deposit txns pulled: ${deposits.length}`);
  for (const dep of deposits) {
    for (const l of dep.Line ?? []) {
      const acct = l.DepositLineDetail?.AccountRef?.value;
      if (acct === ACCT_2110 || acct === ACCT_2115) {
        console.log(`  [${acct === ACCT_2110 ? '2110' : '2115'}] Deposit ${dep.TxnDate}  #${dep.DocNumber ?? dep.Id}  amt=${(l.Amount ?? 0).toFixed(2)}  note=${JSON.stringify((dep.PrivateNote ?? '').slice(0, 100))}`);
      }
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
