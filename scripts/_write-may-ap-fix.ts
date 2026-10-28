// May 2026 close, items 3 + 8 + Stratus (Carson, 2026-10-27: "Proceed with items 1,2,3,5,6,7,8").
// One QBO write per step. Dry run by default (prints the body + pre-checks); --live posts it,
// reads it back and appends to receipt-enrichment/cache/mayap/qbo-write-audit.csv.
//
// Why QBO and not Ramp: the Ramp Developer API cannot link an existing card transaction to an
// existing bill (PATCH /bills has no transaction field; CARD transaction_id exists only on
// POST /bills). Precedent for a QBO-side card BillPayment with the Ramp bill left open: TN
// Bill #16961 / BP #17026 (Webstaurant), Ramp bill f1c09275 still OPEN since January, no second push.
//
// Idempotency: every created record carries `MAYAP:<step>` in PrivateNote; a step whose marker
// already exists in QBO is refused. The bill update checks for its own line.
//   cd web && npx tsx scripts/_write-may-ap-fix.ts --step=<name> [--live]
//   cd web && npx tsx scripts/_write-may-ap-fix.ts --list
import './lib/load-env';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { qbPost, qbQueryAll } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';
import type { JsonValue } from '../src/lib/payroll/store';

interface Ref { value: string; name?: string }
interface QbLine {
  Id?: string;
  Amount: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: { AccountRef: Ref; CustomerRef?: Ref; BillableStatus?: string };
  LinkedTxn?: { TxnId: string; TxnType: string }[];
}
interface QbDoc {
  Id: string;
  SyncToken: string;
  TxnDate?: string;
  TotalAmt?: number;
  Balance?: number;
  PrivateNote?: string;
  VendorRef?: Ref;
  Line?: QbLine[];
}

type Kind = 'BillPayment' | 'VendorCredit' | 'Purchase' | 'JournalEntry' | 'Bill';
interface Step {
  loc: Location;
  kind: Kind;
  /** Bills that must be open for exactly these amounts before the write. */
  open: { billId: string; balance: number; vendorId: string }[];
  body: { [k: string]: JsonValue };
  /** For the Bill update: the line that must not already exist. */
  addsLine?: string;
}

const RAMP_CARD: Record<'FL' | 'TN' | 'TX', Ref> = {
  FL: { value: '309', name: 'Ramp Card' },
  TN: { value: '1150040025', name: 'Ramp' },
  TX: { value: '285', name: 'Ramp Card' },
};
const NO_DOUBLE = 'Ramp bill left OPEN: do not Pay/Match it in Ramp and do not sync the card txn (this BP is the payment).';

function cardBp(entity: 'FL' | 'TN' | 'TX', step: string, vendor: Ref, date: string, billId: string, amount: number, note: string): Step {
  return {
    loc: `MedRock ${entity}` as Location,
    kind: 'BillPayment',
    open: [{ billId, balance: amount, vendorId: vendor.value }],
    body: {
      VendorRef: { ...vendor },
      PayType: 'CreditCard',
      CreditCardPayment: { CCAccountRef: { ...RAMP_CARD[entity] } },
      TxnDate: date,
      TotalAmt: amount,
      PrivateNote: `${note} ${NO_DOUBLE} MAYAP:${step}`,
      Line: [{ Amount: amount, LinkedTxn: [{ TxnId: billId, TxnType: 'Bill' }] }],
    },
  };
}

const BBM_MEMO = 'Dup of TX Bill #1454 (BBM 73545); reverses FL Bill #51336 / JE 1521040525';
const BBM_FL: Ref = { value: '1964', name: 'BBM Services - Cleaning, Remodeling and Construction' };
const FL_DUE_FROM_TX: Ref = { value: '1150040001', name: 'Due From MedRock TX, LLC' };
const TX_IC_CUSTOMER: Ref = { value: '1641', name: 'Medrock Texas Pharmacy, LLC (IC Customer)' };
const STRATUS: Ref = { value: '1610', name: 'Stratus Building Solutions of Tampa' };

const STEPS: Record<string, Step> = {
  'fl-dropper': cardBp('FL', 'fl-dropper', { value: '1647', name: 'DropperBottles.com' }, '2026-05-01', '54712', 1208.8,
    'Paid by FL Ramp card txn f1e8380c 05/01 $1,208.80; Ramp bill 7b426416.'),
  'fl-uline': cardBp('FL', 'fl-uline', { value: '366', name: 'Uline Ship Supplies - AutoPay' }, '2026-05-13', '54710', 592.02,
    'Paid by FL Ramp card txn 0c4ee1cb 05/13 $592.02; Ramp bill a97bf9ae.'),
  'fl-southpointe': cardBp('FL', 'fl-southpointe', { value: '205', name: 'South Pointe Wholesale, Inc. - AutoPay' }, '2026-05-28', '51879', 467.04,
    'Paid by FL Ramp card txn a6164378 05/28 $467.04; Ramp bill 24ec350c.'),
  'tn-cosmetic': cardBp('TN', 'tn-cosmetic', { value: '187', name: 'Cosmetic Packaging - AutoPay' }, '2026-05-11', '21523', 494.2,
    'Paid by TN Ramp card txn c431383b 05/11 $494.20; Ramp bill 942ef391.'),
  // TX South Pointe: the card charge is the invoice + South Pointe's 3.00% card processing fee. The
  // fee goes on the vendor bill as a 6200.65 line, the FL South Pointe convention (e.g. FL Bill
  // #54485 "3% card surcharge"), so one BillPayment settles the whole card charge.
  'tx-southpointe-fee': {
    loc: 'MedRock TX',
    kind: 'Bill',
    open: [{ billId: '1398', balance: 274.34, vendorId: '105' }],
    addsLine: '3% card surcharge',
    body: {
      Amount: 8.23,
      Description: '3% card surcharge (South Pointe inv 806754, paid on TX Ramp card 05/20 $282.57)',
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: '211', name: '6200.65 General & Administrative -:Merchant Service Fees' } },
    },
  },
  'tx-southpointe': cardBp('TX', 'tx-southpointe', { value: '105', name: 'South Pointe' }, '2026-05-20', '1398', 282.57,
    'Paid by TX Ramp card txn ed4e5dd9 05/20 $282.57 = inv 806754 $274.34 + 3% card fee $8.23. No Ramp bill.'),
  // Stratus 05/13 $1,660.88 (USAePay receipt ref 4322292224, sales@ 05/13; Carson: "2 invoices"):
  // inv 26832 $806.25 + inv 27226 $806.25 + 3% fee $48.38. 26832 = Bill #50647 (open). 27226 = Bill
  // #51228, ALREADY paid by check BP #52524 07/10, so its $806.25 stays unapplied on this payment:
  // a Stratus debit balance (double payment) for Kristina to recover.
  'fl-stratus': {
    loc: 'MedRock FL',
    kind: 'BillPayment',
    open: [{ billId: '50647', balance: 806.25, vendorId: STRATUS.value }],
    body: {
      VendorRef: { ...STRATUS },
      PayType: 'CreditCard',
      CreditCardPayment: { CCAccountRef: { ...RAMP_CARD.FL } },
      TxnDate: '2026-05-13',
      TotalAmt: 1612.5,
      PrivateNote: 'FL Ramp card txn cc31374c 05/13 $1,660.88 (USAePay ref 4322292224) = inv 26832 $806.25 (Bill #50647) + inv 27226 $806.25 (Bill #51228, also paid by check BP #52524 07/10: $806.25 left unapplied = double payment, recover from Stratus) + 3% fee $48.38 (separate Purchase). Ramp bill 7f8d0779 left OPEN: do not Pay/Match it in Ramp and do not sync the card txn. MAYAP:fl-stratus',
      Line: [{ Amount: 806.25, LinkedTxn: [{ TxnId: '50647', TxnType: 'Bill' }] }],
    },
  },
  'fl-stratus-fee': {
    loc: 'MedRock FL',
    kind: 'Purchase',
    open: [],
    body: {
      PaymentType: 'CreditCard',
      AccountRef: { ...RAMP_CARD.FL },
      EntityRef: { ...STRATUS, type: 'Vendor' },
      TxnDate: '2026-05-13',
      TotalAmt: 48.38,
      PrivateNote: '3% card fee on FL Ramp card txn cc31374c 05/13 $1,660.88 (Stratus inv 26832 + 27226, $1,612.50 x 3%). Rest of the charge = BillPayment MAYAP:fl-stratus. Do not sync the card txn. MAYAP:fl-stratus-fee',
      Line: [{
        Amount: 48.38,
        Description: '3% card surcharge (Stratus inv 26832 + 27226, USAePay ref 4322292224)',
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: { AccountRef: { value: '143', name: '6200.65 General & Administrative -:Merchant Service Fees' } },
      }],
    },
  },
  // Item 8. FL Bill #51336 was also allocated 100% to TX by Ramp (FL JE 1521041125 Dr Due From TX /
  // Cr 6100.10; TX JE 1521040525 Dr 6100.10 / Cr Due to FL), so the FL credit goes to Due From TX,
  // not 6100.10 (precedent: TN VendorCredit 8327 credits Due From TX for a TX-paid bill).
  'fl-bbm-vc': {
    loc: 'MedRock FL',
    kind: 'VendorCredit',
    open: [{ billId: '51336', balance: 649.5, vendorId: BBM_FL.value }],
    body: {
      VendorRef: { ...BBM_FL },
      TxnDate: '2026-05-31',
      DocNumber: '73545-Void',
      PrivateNote: `${BBM_MEMO} (FL alloc JE 1521041125). MAYAP:fl-bbm-vc`,
      Line: [
        ...[1, 2, 3, 4].map((): JsonValue => ({
          Amount: 150,
          Description: 'Facility Janitorial Cleaning',
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { ...FL_DUE_FROM_TX }, CustomerRef: { ...TX_IC_CUSTOMER } },
        })),
        {
          Amount: 49.5,
          Description: 'Taxes',
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { ...FL_DUE_FROM_TX }, CustomerRef: { ...TX_IC_CUSTOMER } },
        },
      ],
    },
  },
  // $0 BillPayment applying the credit to the bill (Barbara's pattern, e.g. FL BP #54679).
  // VendorCredit id is filled from the fl-bbm-vc write: --vc=<id>.
  'fl-bbm-apply': {
    loc: 'MedRock FL',
    kind: 'BillPayment',
    open: [{ billId: '51336', balance: 649.5, vendorId: BBM_FL.value }],
    body: {
      VendorRef: { ...BBM_FL },
      PayType: 'Check',
      CheckPayment: { PrintStatus: 'NotSet' },
      TxnDate: '2026-05-31',
      TotalAmt: 0,
      PrivateNote: `${BBM_MEMO}. Applies VendorCredit 73545-Void. MAYAP:fl-bbm-apply`,
      Line: [
        { Amount: 649.5, LinkedTxn: [{ TxnId: '51336', TxnType: 'Bill' }] },
        { Amount: 649.5, LinkedTxn: [{ TxnId: '__VC__', TxnType: 'VendorCredit' }] },
      ],
    },
  },
  'tx-bbm-je': {
    loc: 'MedRock TX',
    kind: 'JournalEntry',
    open: [],
    body: {
      TxnDate: '2026-05-31',
      DocNumber: 'BBM73545-REV',
      PrivateNote: `${BBM_MEMO}. MAYAP:tx-bbm-je`,
      Line: [
        {
          Amount: 649.5,
          Description: BBM_MEMO,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Debit',
            AccountRef: { value: '1150040000', name: 'Due to Medrock Pharmacy' },
            Entity: { Type: 'Vendor', EntityRef: { value: '23', name: 'Medrock Pharmacy, LLC (IC Vendor)' } },
          },
        },
        {
          Amount: 649.5,
          Description: BBM_MEMO,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '191', name: '6100.10 Facilities -:Janitorial' } },
        },
      ],
    },
  },
};

const AUDIT = resolve(__dirname, '../../receipt-enrichment/cache/mayap/qbo-write-audit.csv');

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function one(loc: Location, kind: string, id: string): Promise<QbDoc> {
  const [doc] = await qbQueryAll<QbDoc>(loc, kind, `WHERE Id = '${id}'`);
  if (doc === undefined) throw new Error(`${loc} ${kind} #${id} not found`);
  return doc;
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) { console.log(Object.keys(STEPS).join('\n')); return; }
  const name = arg('step');
  const step = name === undefined ? undefined : STEPS[name];
  if (name === undefined || step === undefined) throw new Error(`--step=<${Object.keys(STEPS).join('|')}>`);
  const live = process.argv.includes('--live');
  const marker = `MAYAP:${name}`;

  if (name === 'fl-bbm-apply') {
    const vc = arg('vc');
    if (vc === undefined) throw new Error('--vc=<VendorCredit id from the fl-bbm-vc write>');
    const doc = await one(step.loc, 'VendorCredit', vc);
    if (!(doc.PrivateNote ?? '').includes('MAYAP:fl-bbm-vc') || doc.Balance !== 649.5) throw new Error(`VC #${vc} is not the open MAYAP:fl-bbm-vc credit (bal ${doc.Balance})`);
    const lines = step.body.Line as { LinkedTxn: { TxnId: string }[] }[];
    lines[1].LinkedTxn[0].TxnId = vc;
  }

  // Pre-checks against live QBO, not the cache.
  for (const o of step.open) {
    const bill = await one(step.loc, 'Bill', o.billId);
    console.log(`pre: Bill #${bill.Id} ${bill.TxnDate} vendor=${bill.VendorRef?.value} total=${bill.TotalAmt} bal=${bill.Balance}`);
    if (bill.VendorRef?.value !== o.vendorId) throw new Error(`Bill #${o.billId} vendor ${bill.VendorRef?.value} != ${o.vendorId}`);
    if (bill.Balance !== o.balance) throw new Error(`Bill #${o.billId} balance ${bill.Balance} != expected ${o.balance}; refusing`);
  }
  if (step.kind !== 'Bill') {
    const date = step.body.TxnDate as string;
    if (date <= '2026-04-30') throw new Error(`refusing date ${date} in a closed period`);
    const dupes = (await qbQueryAll<QbDoc>(step.loc, step.kind, `WHERE TxnDate = '${date}'`)).filter((d) => (d.PrivateNote ?? '').includes(marker));
    if (dupes.length > 0) throw new Error(`${marker} already written: ${step.kind} #${dupes.map((d) => d.Id).join(',')}`);
  }

  let endpoint: string;
  let body: { [k: string]: JsonValue };
  let before = '';
  if (step.kind === 'Bill') {
    const bill = await one(step.loc, 'Bill', step.open[0].billId);
    if ((bill.Line ?? []).some((l) => (l.Description ?? '').includes(step.addsLine ?? '\u0000'))) throw new Error(`${marker}: line already on Bill #${bill.Id}`);
    before = `total=${bill.TotalAmt} bal=${bill.Balance} lines=${(bill.Line ?? []).length}`;
    const keep: JsonValue[] = (bill.Line ?? []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail').map((l) => JSON.parse(JSON.stringify(l)) as JsonValue);
    body = { Id: bill.Id, SyncToken: bill.SyncToken, sparse: true, VendorRef: { value: bill.VendorRef?.value ?? '' }, Line: [...keep, step.body] };
    endpoint = 'bill?minorversion=75';
  } else {
    body = step.body;
    endpoint = `${step.kind.toLowerCase()}?minorversion=75`;
  }

  console.log(`${live ? 'LIVE' : 'DRY RUN'} ${step.loc} ${step.kind} ${marker}`);
  console.log(JSON.stringify(body, null, 2));
  if (!live) return;

  const res = await qbPost<{ [k: string]: QbDoc }>(step.loc, endpoint, body);
  const written = res[step.kind];
  if (written === undefined) throw new Error(`no ${step.kind} in response: ${JSON.stringify(res).slice(0, 500)}`);
  const back = await one(step.loc, step.kind, written.Id);
  const after = `total=${back.TotalAmt} bal=${back.Balance ?? ''} date=${back.TxnDate} lines=${(back.Line ?? []).length}`;
  const bills: string[] = [];
  for (const o of step.open) {
    const b = await one(step.loc, 'Bill', o.billId);
    bills.push(`Bill#${b.Id} total=${b.TotalAmt} bal=${b.Balance}`);
  }
  console.log(`WROTE ${step.loc} ${step.kind} #${back.Id} ${after}\nbills after: ${bills.join('; ')}`);
  mkdirSync(resolve(AUDIT, '..'), { recursive: true });
  const row = [new Date().toISOString(), name, step.loc, step.kind, back.Id, before, after, bills.join('; ')].map((c) => `"${c.replace(/"/g, '""')}"`).join(',');
  appendFileSync(AUDIT, `${row}\n`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
