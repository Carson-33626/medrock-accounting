// READ-ONLY: what's left to close out April + May? Buckets the still-OPEN txns by the action each
// needs (approval click / memo / receipt), splits ULINE out, and lists the non-ULINE memo-gap
// merchants so we can see if anything BEYOND ULINE needs work. Zero writes.
import './ramp-split-push/load-env';
import { rampToken, rampGet } from './ramp-split-push/ramp-client';
import type { Entity } from './ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const MONTHS = ['2026-04', '2026-05'];

interface RawTxn {
  amount: number;
  state: string | null;
  all_requirements_met_and_approved: boolean;
  user_transaction_time: string | null;
  memo: string | null;
  merchant_name: string | null;
  receipts: string[] | null;
  card_holder: { first_name?: string; last_name?: string } | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

const isUline = (n: string | null): boolean => /uline/i.test(n ?? '');
const money = (c: number): string => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main(): Promise<void> {
  const open: { entity: Entity; t: RawTxn; ym: string }[] = [];
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, 'transactions:read');
    let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < 100 && next !== null; i++) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, next, token);
      if (res.status !== 200) break;
      const rows = res.body.data ?? [];
      if (rows.length === 0) break;
      for (const t of rows) {
        if (t.state !== 'CLEARED' || t.all_requirements_met_and_approved !== false) continue;
        const ym = (t.user_transaction_time ?? '').slice(0, 7);
        if (MONTHS.includes(ym)) open.push({ entity, t, ym });
      }
      next = res.body.page?.next ?? null;
    }
  }

  const hasMemo = (t: RawTxn): boolean => !!t.memo && t.memo.trim() !== '';
  const hasRcpt = (t: RawTxn): boolean => (t.receipts?.length ?? 0) > 0;

  for (const m of MONTHS) {
    const rows = open.filter((o) => o.ym === m);
    const uline = rows.filter((o) => isUline(o.t.merchant_name));
    const rest = rows.filter((o) => !isUline(o.t.merchant_name));

    const bucket = { approval: [0, 0], memo: [0, 0], receipt: [0, 0], both: [0, 0] };
    const memoMerchants = new Map<string, { n: number; cents: number }>();
    for (const o of rest) {
      const c = Math.round(o.t.amount * 100);
      const nm = !hasMemo(o.t); const nr = !hasRcpt(o.t);
      const k = nm && nr ? 'both' : nm ? 'memo' : nr ? 'receipt' : 'approval';
      bucket[k][0]++; bucket[k][1] += c;
      if (nm) { const key = o.t.merchant_name ?? '(none)'; const e = memoMerchants.get(key) ?? { n: 0, cents: 0 }; e.n++; e.cents += c; memoMerchants.set(key, e); }
    }
    const tot = rows.reduce((s, o) => s + Math.round(o.t.amount * 100), 0);
    console.log(`\n======== ${m} — ${rows.length} open / ${money(tot)} (ULINE: ${uline.length}) ========`);
    console.log(`  Needs APPROVAL click (docs done)   : ${String(bucket.approval[0]).padStart(3)}  ${money(bucket.approval[1])}   <- human, no API`);
    console.log(`  Missing MEMO (non-ULINE)           : ${String(bucket.memo[0]).padStart(3)}  ${money(bucket.memo[1])}`);
    console.log(`  Missing RECEIPT only               : ${String(bucket.receipt[0]).padStart(3)}  ${money(bucket.receipt[1])}`);
    console.log(`  Missing BOTH memo+receipt          : ${String(bucket.both[0]).padStart(3)}  ${money(bucket.both[1])}`);
    console.log(`  ULINE (set aside)                  : ${String(uline.length).padStart(3)}  ${money(uline.reduce((s, o) => s + Math.round(o.t.amount * 100), 0))}`);
    if (memoMerchants.size) {
      console.log('  -- non-ULINE still missing a memo, by merchant --');
      for (const [k, v] of [...memoMerchants.entries()].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`       ${String(v.n).padStart(3)}  ${money(v.cents).padStart(11)}  ${k}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
