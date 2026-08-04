// After the trial's memo POST returned 200, GET /transactions still showed the bookkeeper's text in
// `memo`. Ramp has TWO different things here: the transaction's own `memo` field, and the memo
// object at /memos/{transaction_id} (the one patchMemo writes, which the Amazon work confirmed
// surfaces as the QuickBooks PrivateNote). This prints both, plus the final line items, so we can
// say precisely what changed and what did not. READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-txn-after.ts <FL|TN|TX> <txnId>
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

interface Sel { external_code?: string | null; name?: string | null; category_info?: { type?: string | null } | null }
interface Line { memo?: string | null; amount?: { amount?: number } | null; accounting_field_selections?: Sel[] }
interface Txn { memo?: string | null; sync_status?: string | null; state?: string | null; receipts?: string[]; line_items?: Line[] }

async function main(): Promise<void> {
  const entity = process.argv[2] as Entity;
  const txnId = process.argv[3];
  const token = await rampToken(entity, 'transactions:read memos:read');

  const t = await rampGet<Txn>(entity, `/transactions/${txnId}`, token);
  const b = t.body;
  console.log(`txn ${txnId}`);
  console.log(`  state=${b.state} sync=${b.sync_status} receipts=${(b.receipts ?? []).length}`);
  console.log(`  transaction.memo = ${JSON.stringify(b.memo)}`);

  const m = await rampGet<Record<string, unknown>>(entity, `/memos/${txnId}`, token);
  console.log(`  GET /memos/${txnId} -> HTTP ${m.status}`);
  console.log(`  ${JSON.stringify(m.body).slice(0, 400)}`);

  console.log(`\n  line_items (${(b.line_items ?? []).length}):`);
  for (const l of b.line_items ?? []) {
    const gl = (l.accounting_field_selections ?? [])
      .filter((s) => s.category_info?.type === 'GL_ACCOUNT')
      .map((s) => `${s.external_code ?? '?'} ${s.name ?? ''}`).join(' | ') || '(no GL)';
    console.log(`    $${((l.amount?.amount ?? 0) / 100).toFixed(2).padStart(9)}  ${gl}  memo=${JSON.stringify(l.memo)}`);
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
