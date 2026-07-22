// Fetch REAL Amazon invoice PDFs only for the charges we will actually attach (the confident matches),
// not all ~1200 orders. Groups target orders by their source Amazon Business account, switches the one
// signed-in login to each business, and renders each order's invoice via the fixed (scale-to-fit)
// renderer into the shared per-order cache that run-split reads. CDP-attach to real Chrome required.
//   npx tsx scripts/amazon-csv-enrich/fetch-invoices.ts [--accounts FL,TN,TX] [--orders id1,id2] [--ramp-pages 60] [--limit N] [--force]
import './../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { withAmazonPage } from './amazon-cdp';
import { switchToBusiness, BUSINESS_BY_ACCOUNT } from './account-switcher';
import { fetchInvoicePdf } from './invoice-fetch';
import { loadChargeStore } from './extraction-store';
import { matchCharges } from './matcher';
import { getUnenrichedAmazonTxns, rampToken } from './client';
import { sharedPdfPath } from './paths';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity, RampTxn } from '../ramp-split-push/types';
import type { AmazonCharge } from './types';

const ROOT = 'scripts/amazon-csv-enrich/out';
const MIN_PDF_BYTES = 5_000; // a real Amazon invoice renders ~80-140KB; anything tiny = wrong/blocked page
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function argVal(flag: string): string | null { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null; }
const has = (flag: string): boolean => process.argv.includes(flag);

function discoverAccounts(): string[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '_split').map((d) => d.name);
}

interface Target { orderId: string; account: string; }

async function main(): Promise<void> {
  const accounts = (argVal('--accounts')?.split(',').map((s) => s.trim()).filter(Boolean)) ?? discoverAccounts();
  const onlyOrders = new Set((argVal('--orders')?.split(',').map((s) => s.trim()).filter(Boolean)) ?? []);
  const rampPages = Number(argVal('--ramp-pages') ?? '60') || 60;
  const limit = Number(argVal('--limit') ?? '0') || 0;
  const force = has('--force');
  if (!accounts.length) throw new Error(`No extraction caches under ${ROOT}. Run run-extract.ts first.`);

  // Pool charges, remembering each order's SOURCE account (its owning Business, needed to switch+see it).
  const accountOfOrder = new Map<string, string>();
  const chargeOfOrder = new Map<string, AmazonCharge>();
  const charges: AmazonCharge[] = [];
  for (const a of accounts) {
    const path = `${ROOT}/${a}/charges.json`;
    if (!existsSync(path)) continue;
    for (const rec of loadChargeStore(path).all()) {
      const c = rec.charge;
      if (!chargeOfOrder.has(c.primaryOrderId)) { chargeOfOrder.set(c.primaryOrderId, c); accountOfOrder.set(c.primaryOrderId, a); }
      if (!charges.some((x) => x.paymentRef === c.paymentRef)) charges.push(c);
    }
  }

  // Decide which orders to fetch: an explicit --orders list, else the confident Ramp matches.
  let targets: Target[];
  if (onlyOrders.size) {
    targets = [...onlyOrders].filter((id) => accountOfOrder.has(id)).map((id) => ({ orderId: id, account: accountOfOrder.get(id)! }));
    const missing = [...onlyOrders].filter((id) => !accountOfOrder.has(id));
    if (missing.length) console.log(`  (skip ${missing.length} unknown order ids: ${missing.join(', ')})`);
  } else {
    const pooled: RampTxn[] = [];
    for (const e of ALL_ENTITIES) pooled.push(...await getUnenrichedAmazonTxns(e, await rampToken(e, 'transactions:read'), rampPages));
    const confident = matchCharges(charges, pooled).confident;
    console.log(`matched ${confident.length} confident charges across ${pooled.length} un-enriched Ramp txns`);
    targets = confident.map((m) => ({ orderId: m.charge.primaryOrderId, account: accountOfOrder.get(m.charge.primaryOrderId) ?? accounts[0] }));
  }

  // Skip orders already cached (unless --force), then group by owning account so we switch once per group.
  const todo = targets.filter((t) => force || !existsSync(sharedPdfPath(t.orderId)));
  const byAccount = new Map<string, string[]>();
  for (const t of todo) { const l = byAccount.get(t.account) ?? []; l.push(t.orderId); byAccount.set(t.account, l); }
  const totalPlanned = limit ? Math.min(limit, todo.length) : todo.length;
  console.log(`fetch plan: ${todo.length} missing invoice(s)${limit ? ` (capped ${limit})` : ''} across accounts: ${[...byAccount.keys()].join(', ')}`);

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
