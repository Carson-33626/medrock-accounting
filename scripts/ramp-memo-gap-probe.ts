// READ-ONLY probe: of the OPEN txns still missing a memo (all merchants), how many have a receipt
// (→ OCR-able), what merchants/Ramp-categories they are, and what a generalized memo would look like.
// Zero writes. Run from web/:  npx tsx scripts/ramp-memo-gap-probe.ts
import './lib/load-env';
import { rampToken, rampGet } from './lib/ramp';
import { getReceipt } from './lib/receipt-client';
import { parseOcr } from './lib/ocr-parser';
import type { Entity } from './lib/entities';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const SCOPE = 'transactions:read receipts:read';
const OCR_SAMPLE = 20;

interface RawTxn {
  id: string;
  amount: number;
  state: string | null;
  all_requirements_met_and_approved: boolean;
  user_transaction_time: string | null;
  memo: string | null;
  merchant_name: string | null;
  receipts: string[] | null;
  sk_category_name: string | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

function ym(t: RawTxn): string { return (t.user_transaction_time ?? '').slice(0, 7); }
function isAmazonWalmart(n: string | null): boolean { return /amazon|walmart|sam'?s\s*club|sams\s*club/i.test(n ?? ''); }

async function main(): Promise<void> {
  const gap: { entity: Entity; t: RawTxn }[] = [];
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, SCOPE);
    let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < 100 && next !== null; i++) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, next, token);
      if (res.status !== 200) break;
      const rows = res.body.data ?? [];
      if (rows.length === 0) break;
      for (const t of rows) {
        if (t.state !== 'CLEARED') continue;
        if (t.all_requirements_met_and_approved !== false) continue;
        if (t.memo && t.memo.trim() !== '') continue;
        gap.push({ entity, t });
      }
      next = res.body.page?.next ?? null;
    }
  }

  const hasReceipt = (t: RawTxn): boolean => (t.receipts?.length ?? 0) > 0;
  const nonAW = gap.filter((g) => !isAmazonWalmart(g.t.merchant_name)); // what we haven't already worked

  console.log('============ OPEN + MISSING-MEMO (all merchants, all months) ============');
  console.log(`total missing-memo open: ${gap.length}`);
  console.log(`  Amazon/Walmart (already targeted): ${gap.length - nonAW.length}`);
  console.log(`  OTHER merchants (not yet worked):   ${nonAW.length}`);
  const withR = nonAW.filter((g) => hasReceipt(g.t));
  console.log(`    of OTHER, WITH receipt (OCR-able): ${withR.length}`);
  console.log(`    of OTHER, NO receipt (memo=merchant+category only): ${nonAW.length - withR.length}`);

  for (const focus of ['2026-04', '2026-05']) {
    const f = nonAW.filter((g) => ym(g.t) === focus);
    const fr = f.filter((g) => hasReceipt(g.t));
    console.log(`\n  ${focus}: ${f.length} other-merchant missing-memo | ${fr.length} OCR-able | ${f.length - fr.length} no-receipt`);
  }

  // top merchants + Ramp categories among the not-yet-worked set
  const tally = (key: (g: { t: RawTxn }) => string): [string, number][] => {
    const m = new Map<string, number>();
    for (const g of nonAW) { const k = key(g) || '(none)'; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  };
  console.log('\n--- top OTHER merchants (missing memo) ---');
  for (const [k, n] of tally((g) => g.t.merchant_name ?? '')) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log('\n--- Ramp category (sk_category_name) distribution ---');
  for (const [k, n] of tally((g) => g.t.sk_category_name ?? '')) console.log(`  ${String(n).padStart(4)}  ${k}`);

  // OCR sample: fetch a handful of receipt-bearing OTHER txns, show the memo we'd generate
  console.log(`\n--- SAMPLE generalized memos (OCR + merchant + Ramp category), up to ${OCR_SAMPLE} ---`);
  let shown = 0;
  for (const g of withR) {
    if (shown >= OCR_SAMPLE) break;
    const token = await rampToken(g.entity, SCOPE);
    let items: { desc: string }[] = [];
    try {
      const meta = await getReceipt(g.entity, g.t.receipts![0], token);
      items = parseOcr(meta.ocr).items;
    } catch { /* skip */ }
    const merchant = g.t.merchant_name ?? 'Purchase';
    const cat = g.t.sk_category_name ?? '';
    const itemStr = items.slice(0, 4).map((i) => i.desc).join(', ');
    const memo = `${merchant}${cat ? ` — ${cat}` : ''}${itemStr ? `: ${itemStr}` : ''}`.slice(0, 255);
    console.log(`  [${g.entity}] $${g.t.amount.toFixed(2)} ocr_items=${items.length}\n    "${memo}"`);
    shown++;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
