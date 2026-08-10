// The Amazon Business Transactions report, parsed into charges — the SINGLE source both the invoice
// fetcher and the attach runner pair from. Split sources were the 2026-07-30 field failure: fetch-invoices
// targeted the legacy per-order charges.json while run-attach paired from transactions.csv, so a confident
// pair's invoice was never fetched and the attach stayed dry with `needs_invoice_fetch` forever.
// Charge-level (one row group per Payment Reference ID = one card charge = one Ramp txn target); no
// split/GL fields, per the single-line policy.
import { existsSync, readFileSync } from 'node:fs';
import { parseCsvRows } from './csv-parser';
import { unwrapExcel, parseMoneyCents, parseMDY } from './csv-fields';
import { txnReportPath } from './paths';
import type { AmazonCharge } from './types';

// Ported from the retired split runners' charge-level pairing (run-recon-split.ts / reconcile-txns.ts):
// one row per Payment Reference ID, carrying every Order ID it reconciles to plus the card last-4 the
// matcher uses as a same-amount tiebreaker.
export function parseTxnReport(text: string): AmazonCharge[] {
  const byRef = new Map<string, AmazonCharge>();
  for (const r of parseCsvRows(text)) {
    if (unwrapExcel(r['Transaction Type'] ?? '').toLowerCase() !== 'charge') continue;
    const paymentRef = unwrapExcel(r['Payment Reference ID'] ?? '');
    if (!paymentRef) continue;
    const orderId = unwrapExcel(r['Order ID'] ?? '');
    let c = byRef.get(paymentRef);
    if (!c) {
      const last4 = unwrapExcel(r['Payment Identifier'] ?? '');
      const cents = parseMoneyCents(r['Payment Amount'] ?? '');
      c = {
        paymentRef, orderIds: [], primaryOrderId: orderId, accountGroup: unwrapExcel(r['Account Group'] ?? ''),
        chargeCents: cents, payDate: parseMDY(r['Transaction Date'] ?? ''),
        cardLast4: last4 && last4 !== 'N/A' ? last4 : null, items: [], itemsTotalCents: cents,
      };
      byRef.set(paymentRef, c);
    }
    if (orderId && !c.orderIds.includes(orderId)) c.orderIds.push(orderId);
    if (!c.primaryOrderId && orderId) c.primaryOrderId = orderId;
  }
  return [...byRef.values()];
}

export interface TxnReportDeps {
  exists: (path: string) => boolean;
  read: (path: string) => string;
}
export const defaultTxnReportDeps = (): TxnReportDeps => ({
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
});

export interface LoadedCharges {
  charges: AmazonCharge[];
  /** order id -> the account whose report first listed it (the Business the invoice is visible under). */
  accountOfOrder: Map<string, string>;
  /** accounts with no cached report — the caller decides whether that is fatal or just a narrower pool. */
  missing: { account: string; path: string }[];
}

// Pool charges across accounts, de-duped by Payment Reference ID (first account listing a ref wins, so a
// ref appearing in two exports cannot double-claim a txn downstream).
export function loadTxnReportCharges(accounts: string[], deps: TxnReportDeps = defaultTxnReportDeps()): LoadedCharges {
  const byRef = new Map<string, AmazonCharge>();
  const accountOfOrder = new Map<string, string>();
  const missing: { account: string; path: string }[] = [];
  for (const account of accounts) {
    const path = txnReportPath(account);
    if (!deps.exists(path)) { missing.push({ account, path }); continue; }
    for (const c of parseTxnReport(deps.read(path))) {
      if (!byRef.has(c.paymentRef)) byRef.set(c.paymentRef, c);
      for (const id of c.orderIds.length ? c.orderIds : [c.primaryOrderId]) {
        if (id && !accountOfOrder.has(id)) accountOfOrder.set(id, account);
      }
    }
  }
  return { charges: [...byRef.values()], accountOfOrder, missing };
}
