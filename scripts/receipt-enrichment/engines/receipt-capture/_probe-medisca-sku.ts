// Probe: can we learn SKU -> GL account from the overlap between the portal and QuickBooks?
//
// Why this matters. The GL classifier replays her QB DESCRIPTIONS. But create mode gets its lines
// from the portal, and the portal's vocabulary is different:
//     QB / Ramp draft : Gloves, Blue Nitrile Powder-Free, (S - 9"- 4 mil) (Non-Sterile) Safe-Sense
//     invoice PDF     : Gloves, Blue Nitrile Powder-Free,        <- truncated, Safe-Sense absent
//     order page      : Nitrile Gloves 9" 4mil                   <- different wording entirely
// So a description-matching classifier that works perfectly on enrich will largely MISS on create.
//
// The order page carries a stable SKU ("5743-01"). If invoices present in BOTH systems let us join
// portal lines to QB lines by amount, we can learn SKU -> account and classify create-mode lines on
// an identifier instead of on prose.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-medisca-sku.ts [limit]
import '../ramp-split-push/load-env';
import { MediscaSession } from './medisca-session';
import { parseInvoiceList, invoiceListPath } from './medisca-invoices';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../../../src/lib/quickbooks-multi';

const VENDOR_RE = /medisca/i;
const SINCE = '2026-01-01';
const LIMIT = Number(process.argv[2] ?? '25');

interface QbLine { Description?: string; Amount?: number; AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } } }
interface QbBill { DocNumber?: string; TxnDate?: string; VendorRef?: { name?: string }; Line?: QbLine[] }

interface OrderLine { sku: string; name: string; amountCents: number }

function cents(s: string): number {
  const t = s.replace(/[$,\s]/g, '');
  const neg = t.startsWith('(') || t.startsWith('-');
  const n = Number(t.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) * (neg ? -1 : 1) : 0;
}

function parseOrderLines(html: string): OrderLine[] {
  const out: OrderLine[] = [];
  for (const row of [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1]
      .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
      .replace(/\s+/g, ' ').trim());
    if (cells.length < 8) continue;
    const [, sku, name, , , , subtotal] = cells;
    if (!/^\d{3,}-\d+$/.test(sku)) continue;
    out.push({ sku, name, amountCents: cents(subtotal) });
  }
  return out;
}

async function main(): Promise<void> {
  // QB side, keyed by invoice number.
  const qb = new Map<string, { desc: string; account: string; amountCents: number }[]>();
  for (const entity of ALL_ENTITIES) {
    const rows = await qbQueryAll<QbBill>(ENTITY_TO_QB_LOCATION[entity], 'Bill', `WHERE TxnDate >= '${SINCE}'`);
    for (const b of rows.filter((r) => VENDOR_RE.test(r.VendorRef?.name ?? ''))) {
      const key = (b.DocNumber ?? '').trim().replace(/^0+/, '');
      if (key === '') continue;
      qb.set(key, (b.Line ?? []).map((l) => ({
        desc: (l.Description ?? '').trim(),
        account: (l.AccountBasedExpenseLineDetail?.AccountRef?.name ?? '').split(' ')[0],
        amountCents: Math.round((l.Amount ?? 0) * 100),
      })).filter((l) => l.account !== ''));
    }
  }
  console.log(`QB: ${qb.size} Medisca invoices since ${SINCE}\n`);

  const skuAccounts = new Map<string, Map<string, number>>();
  const skuNames = new Map<string, string>();
  let joined = 0;
  let linesJoined = 0;
  let ambiguousAmount = 0;

  for (const entity of ALL_ENTITIES) {
    const sess = await MediscaSession.login(entity as Entity);
    const rows: { invoiceNumberRaw: string; orderNumber: string }[] = [];
    for (const paid of [true, false]) {
      const res = await sess.get(invoiceListPath(paid, 100, 1));
      rows.push(...parseInvoiceList(res.text));
    }
    const overlap = rows.filter((r) => qb.has(r.invoiceNumberRaw.replace(/^0+/, ''))).slice(0, LIMIT);
    console.log(`[${entity}] ${rows.length} portal invoices, ${overlap.length} also in QB (probing ${overlap.length})`);

    for (const r of overlap) {
      const page = await sess.get(`/dashboard/orders/${r.orderNumber}`);
      const lines = parseOrderLines(page.text);
      const qbLines = qb.get(r.invoiceNumberRaw.replace(/^0+/, '')) ?? [];
      if (lines.length === 0 || qbLines.length === 0) continue;
      joined++;

      for (const pl of lines) {
        const matches = qbLines.filter((q) => q.amountCents === pl.amountCents);
        if (matches.length !== 1) { ambiguousAmount++; continue; }
        linesJoined++;
        const m = skuAccounts.get(pl.sku) ?? new Map<string, number>();
        m.set(matches[0].account, (m.get(matches[0].account) ?? 0) + 1);
        skuAccounts.set(pl.sku, m);
        skuNames.set(pl.sku, pl.name);
      }
    }
  }

  console.log(`\njoined ${joined} invoice(s); ${linesJoined} line(s) matched 1:1 by amount, ${ambiguousAmount} ambiguous`);
  console.log(`learned ${skuAccounts.size} distinct SKU(s)\n`);

  let unanimous = 0;
  for (const [sku, accounts] of [...skuAccounts].sort((a, b) => b[1].size - a[1].size)) {
    const total = [...accounts.values()].reduce((a, n) => a + n, 0);
    const sorted = [...accounts].sort((x, y) => y[1] - x[1]);
    if (accounts.size === 1) unanimous++;
    if (accounts.size > 1 || total >= 3) {
      console.log(`  ${sku.padEnd(12)} ${sorted.map(([a, n]) => `${a}x${n}`).join(' ').padEnd(28)} ${skuNames.get(sku) ?? ''}`);
    }
  }
  console.log(`\nSKUs with a single unambiguous account: ${unanimous}/${skuAccounts.size}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
