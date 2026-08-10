// Fetch REAL Amazon invoice PDFs only for the charges run-attach.ts will actually attach (its confident
// pairs), not all ~1200 orders. Groups target orders by their source Amazon Business account, switches the
// one signed-in login to each business, and renders each order's invoice via the fixed (scale-to-fit)
// renderer into the shared per-order cache run-attach.ts reads. CDP-attach to real Chrome required.
//
// Targets come from the SAME pair computation run-attach.ts performs — same charge source (the cached
// Transactions reports, via txn-report.ts) and same Ramp pool (receiptless + unsynced Amazon-family) — so
// "fetched" and "attachable" can never drift apart. They did before 2026-07-30: this script targeted the
// legacy per-order charges.json while run-attach paired from transactions.csv, so FL's confident pairs sat
// at `needs_invoice_fetch` through two sweeps while 259 unrelated invoices were fetched.
//   npx tsx scripts/receipt-enrichment/engines/amazon-csv-enrich/fetch-invoices.ts [--accounts FL,TN,TX] [--orders id1,id2] [--ramp-pages 260] [--limit N] [--force]
import './../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withAmazonPage } from './amazon-cdp';
import { switchToBusiness, BUSINESS_BY_ACCOUNT } from './account-switcher';
import { fetchInvoicePdf } from './invoice-fetch';
import { loadTxnReportCharges } from './txn-report';
import { matchCharges } from './matcher';
import { getReceiptlessAmazonTxns, rampToken } from './client';
import { sharedPdfPath } from './paths';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity, RampTxn } from '../ramp-split-push/types';

const MIN_PDF_BYTES = 5_000; // a real Amazon invoice renders ~30-140KB; anything tiny = wrong/blocked page
const SCOPES_READ = 'transactions:read receipts:read';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function argVal(flag: string): string | null { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null; }
const has = (flag: string): boolean => process.argv.includes(flag);

interface Target { orderId: string; account: string; }

async function main(): Promise<void> {
  // Accounts are entity labels: an account IS a Business export dir, and run-attach pools by entity.
  const requested = argVal('--accounts')?.split(',').map((s) => s.trim()).filter(Boolean);
  const accounts: Entity[] = (requested ?? [...ALL_ENTITIES]) as Entity[];
  for (const a of accounts) {
    if (!ALL_ENTITIES.includes(a)) throw new Error(`Unknown --accounts entry ${a as string} (expected FL, TN, or TX)`);
  }
  const onlyOrders = new Set((argVal('--orders')?.split(',').map((s) => s.trim()).filter(Boolean)) ?? []);
  const rampPages = Number(argVal('--ramp-pages') ?? '260') || 260;
  const limit = Number(argVal('--limit') ?? '0') || 0;
  const force = has('--force');

  const { charges, accountOfOrder, missing } = loadTxnReportCharges(accounts);
  for (const m of missing) console.log(`[${m.account}] no transactions.csv cached — run run-extract-txns.ts --account ${m.account} first`);
  if (!charges.length) throw new Error(`No cached Transactions reports for ${accounts.join(', ')}. Run run-extract-txns.ts per account first.`);

  // Decide which orders to fetch: an explicit --orders list, else exactly run-attach's confident pairs.
  let targets: Target[];
  if (onlyOrders.size) {
    targets = [...onlyOrders].filter((id) => accountOfOrder.has(id)).map((id) => ({ orderId: id, account: accountOfOrder.get(id)! }));
    const unknown = [...onlyOrders].filter((id) => !accountOfOrder.has(id));
    if (unknown.length) console.log(`  (skip ${unknown.length} order id(s) absent from the cached reports: ${unknown.join(', ')})`);
  } else {
    // Always pool EVERY entity, even when --accounts narrows the charge side. matchCharges' confidence
    // depends on the whole pool (a txn claimed by two charges is contested), and a charge can pair to a
    // txn in another entity's books — narrowing the pool could hide such a pair and strand it right back
    // at needs_invoice_fetch, which is the bug this file exists to prevent.
    const pool: RampTxn[] = [];
    for (const e of ALL_ENTITIES) pool.push(...await getReceiptlessAmazonTxns(e, await rampToken(e, SCOPES_READ), rampPages));
    const { confident } = matchCharges(charges, pool);
    console.log(`matched ${confident.length} confident charge(s) across ${pool.length} receiptless Ramp txn(s)`);
    targets = confident.map((m) => ({ orderId: m.charge.primaryOrderId, account: accountOfOrder.get(m.charge.primaryOrderId) ?? accounts[0] }));
  }

  // The cache is per ORDER while targets are per CHARGE, and one order can bill as several charges
  // (split shipments) — de-dupe so a multi-shipment order is rendered once, not once per charge.
  const seen = new Set<string>();
  const todo: Target[] = [];
  for (const t of targets) {
    if (!t.orderId || seen.has(t.orderId)) continue;
    seen.add(t.orderId);
    if (force || !existsSync(sharedPdfPath(t.orderId))) todo.push(t);
  }
  const byAccount = new Map<string, string[]>();
  for (const t of todo) { const l = byAccount.get(t.account) ?? []; l.push(t.orderId); byAccount.set(t.account, l); }
  const totalPlanned = limit ? Math.min(limit, todo.length) : todo.length;
  console.log(`fetch plan: ${todo.length} missing invoice(s) of ${seen.size} distinct target order(s)${limit ? ` (capped ${limit})` : ''}${byAccount.size ? ` across accounts: ${[...byAccount.keys()].join(', ')}` : ''}`);
  if (!todo.length) {
    // Distinguish "all cached" from "no targets at all" — after a seam bug that stranded pairs for two
    // sweeps, telling an operator everything is cached when nothing matched is the wrong reassurance.
    console.log(seen.size
      ? 'nothing to fetch — every target order already has a cached invoice'
      : 'nothing to fetch — NO target orders resolved (no confident pairs, or no --orders id matched a cached report)');
    return;
  }

  let fetched = 0, failed = 0;
  await withAmazonPage(async (page) => {
    for (const [account, orderIds] of byAccount) {
      if (limit && fetched >= limit) break;
      const business = BUSINESS_BY_ACCOUNT[account] || '';
      if (business) { console.log(`[${account}] switching to "${business}"...`); await switchToBusiness(page, business); }
      for (const orderId of orderIds) {
        if (limit && fetched >= limit) break;
        try {
          const pdf = await fetchInvoicePdf(page, orderId);
          if (pdf.length < MIN_PDF_BYTES) throw new Error(`invoice too small (${pdf.length}B) — order not visible under ${business}?`);
          const out = sharedPdfPath(orderId);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, pdf);
          fetched++;
          console.log(`  [${account}] ${orderId} -> ${(pdf.length / 1024).toFixed(0)}KB (${fetched}/${totalPlanned})`);
        } catch (e) {
          failed++;
          console.error(`  [${account}] ${orderId} FAILED: ${(e as Error).message}`);
        }
        await sleep(1500);
      }
    }
  });
  console.log(`\nfetch-invoices done: +${fetched} cached, ${failed} failed. cache dir: ${dirname(sharedPdfPath('x'))}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
