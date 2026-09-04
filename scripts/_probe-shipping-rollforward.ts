/**
 * READ-ONLY dry run: the 1220.30 roll-forward, and what the accrual would draft.
 *
 * The single number this exists to prove: **1220.30 has not been relieved to COGS
 * since 2026-02-28 in any entity.** It rebuilds each month of 2026 as
 * `opening + Bill/Purchase activity + journal movement = closing` and checks the
 * result against the QuickBooks BalanceSheet, so the claim is arithmetic rather
 * than assertion.
 *
 * Then it runs `fetchShippingAccrual` — the same code path a screen or a generate
 * button would — and prints the pair each month would draft, WITHOUT saving a
 * draft or touching QuickBooks with anything but SELECT.
 *
 * BalanceSheet calls go through `getBalanceSheetInventory`, which passes the
 * mandatory `start_date`: QuickBooks silently ignores `end_date` without one and
 * answers 200 with the wrong period.
 *
 * Run from web/:  npx tsx scripts/_probe-shipping-rollforward.ts
 */
import './lib/load-env';
import { getBalanceSheetInventory, qbQueryAll, type Location } from '../src/lib/quickbooks-multi';
import { fetchShippingAccrual } from '../src/lib/inventory/shipping-packaging-server';
import { buildShippingAccrualDrafts } from '../src/lib/inventory/shipping-packaging-je';
import { SHIPPING_LOCATIONS, monthEndOf } from '../src/lib/inventory/shipping-packaging-accrual';

const ASSET_ACCT = '1220.30';
const MONTHS: readonly string[] = [
  '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
];

interface AccountRow {
  Id: string;
  AcctNum?: string;
}

interface DocLine {
  Amount?: number;
  AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string } };
}

interface PurchaseDoc {
  Id: string;
  TxnDate?: string;
  Line?: DocLine[];
}

interface JeLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: { PostingType?: 'Debit' | 'Credit'; AccountRef?: { value?: string } };
}

interface JeDoc {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  Line?: JeLine[];
}

interface MonthMove {
  purchases: number;
  jeDebits: number;
  jeCredits: number;
  /** JE credits whose entry reads as a COGS relief rather than a transfer. */
  reliefCredits: number;
  notes: string[];
}

/** A relief entry is one the accountant labelled as an inventory adjustment. */
const RELIEF_DOC = /inv ?adj/i;

const round2 = (n: number): number => Math.round(n * 100) / 100;

async function rollForward(location: Location): Promise<void> {
  const accounts = await qbQueryAll<AccountRow>(location, 'Account', '');
  const assetIds = new Set(accounts.filter((a) => a.AcctNum === ASSET_ACCT).map((a) => a.Id));
  if (assetIds.size === 0) {
    console.log(`${location}: no ${ASSET_ACCT} account\n`);
    return;
  }

  const where = `WHERE TxnDate >= '2026-01-01'`;
  const [bills, purchases, jes] = await Promise.all([
    qbQueryAll<PurchaseDoc>(location, 'Bill', where),
    qbQueryAll<PurchaseDoc>(location, 'Purchase', where),
    qbQueryAll<JeDoc>(location, 'JournalEntry', where),
  ]);

  const moves = new Map<string, MonthMove>();
  const move = (m: string): MonthMove => {
    const existing = moves.get(m);
    if (existing !== undefined) return existing;
    const fresh: MonthMove = { purchases: 0, jeDebits: 0, jeCredits: 0, reliefCredits: 0, notes: [] };
    moves.set(m, fresh);
    return fresh;
  };

  for (const doc of [...bills, ...purchases]) {
    const month = (doc.TxnDate ?? '').slice(0, 7);
    if (month === '') continue;
    for (const line of doc.Line ?? []) {
      const acct = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
      if (acct === undefined || !assetIds.has(acct)) continue;
      move(month).purchases += line.Amount ?? 0;
    }
  }

  for (const je of jes) {
    const month = (je.TxnDate ?? '').slice(0, 7);
    if (month === '') continue;
    for (const line of je.Line ?? []) {
      const acct = line.JournalEntryLineDetail?.AccountRef?.value;
      if (acct === undefined || !assetIds.has(acct)) continue;
      const amt = line.Amount ?? 0;
      const m = move(month);
      if (line.JournalEntryLineDetail?.PostingType === 'Debit') m.jeDebits += amt;
      else {
        m.jeCredits += amt;
        if (RELIEF_DOC.test(je.DocNumber ?? '')) {
          m.reliefCredits += amt;
          m.notes.push(`relief ${amt.toFixed(2)} (#${je.DocNumber ?? ''})`);
        }
      }
    }
  }

  // Opening balance = the December 2025 month-end, which the scope ruling lets us
  // READ as a starting point without doing any 2025 work.
  const opening = await getBalanceSheetInventory(location, '2025-12-31');
  const openingRow = opening?.accounts.find((a) => a.name.startsWith(`${ASSET_ACCT} `));
  let running = openingRow?.value ?? 0;

  console.log(`${location} — ${ASSET_ACCT} roll-forward`);
  console.log(
    `${'month'.padEnd(9)} ${'opening'.padStart(12)} ${'purchases'.padStart(11)} ` +
      `${'JE Dr'.padStart(11)} ${'JE Cr'.padStart(11)} ${'relief'.padStart(10)} ` +
      `${'computed'.padStart(12)} ${'per QBO'.padStart(12)} ${'diff'.padStart(8)}`,
  );
  console.log(`${'opening'.padEnd(9)} ${running.toFixed(2).padStart(12)}   (2025-12-31)`);

  for (const month of MONTHS) {
    const m = moves.get(month) ?? {
      purchases: 0,
      jeDebits: 0,
      jeCredits: 0,
      reliefCredits: 0,
      notes: [],
    };
    const open = running;
    const computed = round2(open + m.purchases + m.jeDebits - m.jeCredits);
    const bs = await getBalanceSheetInventory(location, monthEndOf(month));
    const row = bs?.accounts.find((a) => a.name.startsWith(`${ASSET_ACCT} `));
    const actual = row === undefined ? null : row.value;
    const diff = actual === null ? null : round2(computed - actual);
    console.log(
      `${month.padEnd(9)} ${open.toFixed(2).padStart(12)} ${m.purchases.toFixed(2).padStart(11)} ` +
        `${m.jeDebits.toFixed(2).padStart(11)} ${m.jeCredits.toFixed(2).padStart(11)} ` +
        `${m.reliefCredits.toFixed(2).padStart(10)} ${computed.toFixed(2).padStart(12)} ` +
        `${(actual === null ? 'n/a' : actual.toFixed(2)).padStart(12)} ` +
        `${(diff === null ? '—' : diff.toFixed(2)).padStart(8)}${diff !== null && diff !== 0 ? '  <-- DOES NOT TIE' : ''}`,
    );
    running = actual ?? computed;
  }
  console.log('');
}

async function main(): Promise<void> {
  console.log('=== 1. Roll-forward — does the account tie, and when did relief stop? ===\n');
  for (const location of SHIPPING_LOCATIONS) {
    await rollForward(location as Location);
  }

  console.log('=== 2. Dry run — what the accrual would draft for each month of 2026 ===\n');
  const { asOf, trailingWindow, months, unavailable } = await fetchShippingAccrual(MONTHS.length);
  console.log(`asOf ${asOf}   trailing window ${trailingWindow[0]}..${trailingWindow[trailingWindow.length - 1]}\n`);
  console.log(
    `${'location'.padEnd(13)} ${'month'.padEnd(9)} ${'days'.padStart(5)} ${'observed'.padStart(11)} ` +
      `${'docs'.padStart(5)} ${'complete'.padStart(9)} ${'trailing avg'.padStart(13)} ` +
      `${'ACCRUAL'.padStart(11)} flags`,
  );
  for (const r of months) {
    const flags: string[] = [];
    if (r.zeroEntryOverride) flags.push('zero-entry');
    if (r.flagged) flags.push('REVIEW');
    if (r.borrowedCurve) flags.push('borrowed-curve');
    if (r.thinHistory) flags.push('thin-history');
    console.log(
      `${r.location.padEnd(13)} ${r.month.padEnd(9)} ${String(r.daysElapsed).padStart(5)} ` +
        `${r.observedToDate.toFixed(2).padStart(11)} ${String(r.observedDocs).padStart(5)} ` +
        `${(r.completeness * 100).toFixed(0).padStart(8)}% ${r.trailingAverage.toFixed(2).padStart(13)} ` +
        `${r.accrual.toFixed(2).padStart(11)} ${flags.join(' ')}`,
    );
  }
  if (unavailable.length > 0) console.log(`\nunavailable: ${unavailable.join(', ')}`);
  console.log('');

  console.log('=== 3. The entries those numbers become (NOT saved, NOT posted) ===\n');
  for (const r of months) {
    if (monthEndOf(r.month) >= asOf) continue;
    const pair = buildShippingAccrualDrafts({
      location: r.location,
      month: r.month,
      accrual: r.accrual,
      completeness: r.completeness,
      zeroEntryOverride: r.zeroEntryOverride,
    });
    if (pair === null) continue;
    for (const half of [pair.accrual, pair.reversal]) {
      console.log(`${half.entity}  ${(half.docNumber ?? '').padEnd(18)} ${half.txnDate ?? ''}`);
      for (const l of half.lines) {
        console.log(
          `      ${l.postingType.padEnd(7)} ${l.amount.toFixed(2).padStart(11)}  ${l.accountName}`,
        );
      }
    }
  }
  console.log('\nNothing was written. No draft saved, no QuickBooks entry created.');
}

void main();
