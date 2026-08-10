// READ-ONLY: (1) confirm each entity's accounting connection type (DIRECT native-QB vs API-based) to
// settle whether we can push to QBO ourselves; (2) break down the Apr/May missing-receipt txns by
// merchant and flag which our Amazon/Walmart receipt pipelines could auto-attach. Zero writes.
import './receipt-enrichment/engines/ramp-split-push/load-env';
import { rampToken, rampGet } from './receipt-enrichment/engines/ramp-split-push/ramp-client';
import type { Entity } from './receipt-enrichment/engines/ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const MONTHS = ['2026-04', '2026-05'];
const money = (c: number): string => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pipelineCoverable = (n: string | null): boolean => /amazon|walmart|sam'?s\s*club|sams\s*club/i.test(n ?? '');

interface Conn { connection_type?: string; remote_provider_name?: string; accounting_provider?: string; is_active?: boolean }
interface RawTxn {
  amount: number; state: string | null; all_requirements_met_and_approved: boolean;
  user_transaction_time: string | null; memo: string | null; merchant_name: string | null; receipts: string[] | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

async function main(): Promise<void> {
  console.log('======== ACCOUNTING CONNECTION TYPE (settles QBO-push feasibility) ========');
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, 'accounting:read');
    const { status, body } = await rampGet<{ data?: Conn[] }>(entity, '/accounting/all-connections', token);
    const conns = body.data ?? [];
    console.log(`  ${entity}: ${status === 200 ? conns.map((c) => `${c.remote_provider_name ?? c.accounting_provider ?? '?'} / ${c.connection_type ?? '?'}${c.is_active === false ? ' (inactive)' : ''}`).join('; ') || '(none)' : 'HTTP ' + status}`);
  }

  console.log('\n======== APR/MAY MISSING-RECEIPT (memo present, no receipt), non-ULINE ========');
  for (const m of MONTHS) {
    const byMerchant = new Map<string, { n: number; cents: number; coverable: boolean }>();
    let n = 0; let cents = 0; let covN = 0; let covCents = 0;
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
          if ((t.user_transaction_time ?? '').slice(0, 7) !== m) continue;
          if (/uline/i.test(t.merchant_name ?? '')) continue;
          const hasMemo = !!t.memo && t.memo.trim() !== '';
          const hasRcpt = (t.receipts?.length ?? 0) > 0;
          if (!hasMemo || hasRcpt) continue; // only memo-present + receipt-missing
          const c = Math.round(t.amount * 100);
          n++; cents += c;
          const cov = pipelineCoverable(t.merchant_name);
          if (cov) { covN++; covCents += c; }
          const key = t.merchant_name ?? '(none)';
          const e = byMerchant.get(key) ?? { n: 0, cents: 0, coverable: cov };
          e.n++; e.cents += c; byMerchant.set(key, e);
        }
        next = res.body.page?.next ?? null;
      }
    }
    console.log(`\n  --- ${m}: ${n} txns / ${money(cents)} missing a receipt ---`);
    console.log(`      pipeline-coverable (Amazon/Walmart/Sam's): ${covN} / ${money(covCents)}  |  needs human upload: ${n - covN} / ${money(cents - covCents)}`);
    console.log('      by merchant:');
    for (const [k, v] of [...byMerchant.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20)) {
      console.log(`        ${String(v.n).padStart(3)}  ${money(v.cents).padStart(11)}  ${v.coverable ? '[pipeline]' : '          '} ${k}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
