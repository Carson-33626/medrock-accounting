// RECONCILIATION CHECK: pair Ramp Amazon card txns to Amazon "Transactions report" charges (the ACTUAL
// batched charges, each carrying the Order ID it reconciles to) — the source that matches Ramp 1:1 where
// the order-level Items report could not. Read-only: reports coverage + emits the txn->order pairing so a
// follow-up extract can pull receipts and itemize. Uses the same amount+date+mutual-uniqueness matcher.
//   npx tsx scripts/amazon-csv-enrich/reconcile-txns.ts [--from 2026-04-01 --to 2026-05-31] [--pages 260]
import './../ramp-split-push/load-env';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { parseCsvRows } from './csv-parser';
import { unwrapExcel, parseMoneyCents, parseMDY } from './csv-fields';
import { matchCharges } from './matcher';
import { getUnenrichedAmazonTxns, rampToken } from './client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity, RampTxn } from '../ramp-split-push/types';
import type { AmazonCharge } from './types';

const ROOT = 'scripts/amazon-csv-enrich/out';
const OUT = `${ROOT}/_recon`;
function argVal(f: string, d: string): string { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; }
function csv(v: unknown): string { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
const inWin = (d: string, from: string, to: string): boolean => !!d && d >= from && d <= to;

// One row per (Payment Reference ID) charge, collecting every Order ID that charge reconciles to.
function parseTxnReport(text: string): AmazonCharge[] {
  const byRef = new Map<string, AmazonCharge>();
  for (const r of parseCsvRows(text)) {
    const type = unwrapExcel(r['Transaction Type'] ?? '');
    if (type && type.toLowerCase() !== 'charge') continue; // drop refunds/adjustments
    const paymentRef = unwrapExcel(r['Payment Reference ID'] ?? '');
    if (!paymentRef) continue;
    const orderId = unwrapExcel(r['Order ID'] ?? '');
    let c = byRef.get(paymentRef);
    if (!c) {
      const last4 = unwrapExcel(r['Payment Identifier'] ?? '');
      const cents = parseMoneyCents(r['Payment Amount'] ?? '');
      c = { paymentRef, orderIds: [], primaryOrderId: orderId, accountGroup: unwrapExcel(r['Account Group'] ?? ''),
        chargeCents: cents, payDate: parseMDY(r['Transaction Date'] ?? ''), cardLast4: last4 && last4 !== 'N/A' ? last4 : null,
        items: [], itemsTotalCents: cents };
      byRef.set(paymentRef, c);
    }
    if (orderId && !c.orderIds.includes(orderId)) c.orderIds.push(orderId);
    if (!c.primaryOrderId && orderId) c.primaryOrderId = orderId;
  }
  return [...byRef.values()];
}

async function main(): Promise<void> {
  const from = argVal('--from', '2026-04-01'), to = argVal('--to', '2026-05-31');
  const pages = Number(argVal('--pages', '260')) || 260;
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  // Pool charge rows from all 3 transactions reports, dedupe by Payment Reference ID.
  const byRef = new Map<string, AmazonCharge>();
  let rawRows = 0;
  for (const a of readdirSync(ROOT).filter((d) => !d.startsWith('_'))) {
    const p = `${ROOT}/${a}/transactions.csv`;
    if (!existsSync(p)) continue;
    const charges = parseTxnReport(readFileSync(p, 'utf8'));
    rawRows += charges.length;
    for (const c of charges) if (!byRef.has(c.paymentRef)) byRef.set(c.paymentRef, c);
  }
  const charges = [...byRef.values()];
  console.log(`transactions-report charges: ${rawRows} raw -> ${charges.length} unique (across FL/TN/TX)`);

  // Ramp un-enriched Amazon txns (deep pool so April/May is included).
  const pool: RampTxn[] = [];
  for (const e of ALL_ENTITIES) {
    const txns = await getUnenrichedAmazonTxns(e, await rampToken(e, 'transactions:read'), pages);
    pool.push(...txns);
    console.log(`  ${e}: ${txns.length} un-enriched Amazon txns (${txns.filter((t) => inWin(t.date, from, to)).length} in window)`);
  }

  const { confident, ambiguous, unmatched } = matchCharges(charges, pool);
  const paired = new Map(confident.map((m) => [m.txn.id, m] as const));
  const report = (label: string, txns: RampTxn[]): void => {
    const p = txns.filter((t) => paired.has(t.id));
    const amt = (xs: RampTxn[]): string => `$${xs.reduce((s, t) => s + t.amountCents / 100, 0).toFixed(2)}`;
    console.log(`  ${label.padEnd(16)} ${txns.length} txns (${amt(txns)}) -> paired ${p.length} (${amt(p)}), unpaired ${txns.length - p.length} (${amt(txns.filter((t) => !paired.has(t.id)))})`);
  };
  console.log(`\n=== RECONCILIATION (Ramp un-enriched Amazon -> transactions-report charge/order) ===`);
  report('ALL un-enriched', pool);
  report(`${from}..${to}`, pool.filter((t) => inWin(t.date, from, to)));
  console.log(`\n  matcher: confident ${confident.length}, ambiguous ${ambiguous.length}, unmatched charges ${unmatched.length}`);

  // Emit the pairing (txn -> order ids) for the receipt extract + itemization step.
  const rows = ['ramp_txn_id,entity,txn_date,amount,payment_ref,order_ids'];
  for (const m of confident) rows.push([m.txn.id, m.txn.entity, m.txn.date, (m.txn.amountCents / 100).toFixed(2), m.charge.paymentRef, m.charge.orderIds.join('|')].map(csv).join(','));
  writeFileSync(`${OUT}/txn_order_pairs.csv`, rows.join('\n'));
  const winPairs = confident.filter((m) => inWin(m.txn.date, from, to));
  console.log(`\nWrote ${OUT}/txn_order_pairs.csv (${confident.length} pairs; ${winPairs.length} in ${from}..${to})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
