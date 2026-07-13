// READ-ONLY probe. Dumps the raw shape of one Amazon Ramp txn + its receipt (incl. any `ocr`
// block) per entity, so we can decide the parse source before rebuilding the enrichment engine.
// Run: cd web && npx tsx scripts/amazon-enrich/_probe-shape.ts
import '../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const SCOPES = 'transactions:read receipts:read accounting:read';

interface RawTxn {
  id: string;
  amount: number;
  merchant_name: string | null;
  sk_category_name?: string | null;
  user_transaction_time?: string;
  sync_status?: string;
  state?: string;
  line_items?: unknown[];
  receipts?: string[];
  [k: string]: unknown;
}

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    console.log(`\n================= ${entity} =================`);
    let token: string;
    try {
      token = await rampToken(entity, SCOPES);
    } catch (e) {
      console.log(`  token FAILED: ${(e as Error).message}`);
      continue;
    }
    const { status, body } = await rampGet<{ data: RawTxn[] }>(
      entity,
      '/transactions?page_size=100&order_by_date_desc=true',
      token,
    );
    if (status !== 200) {
      console.log(`  txns HTTP ${status}`);
      continue;
    }
    const all = body.data ?? [];
    const amazon = all.filter((t) => /amazon/i.test(t.merchant_name ?? ''));
    console.log(`  page1: ${all.length} txns, ${amazon.length} Amazon`);
    const sample = amazon.find((t) => (t.receipts?.length ?? 0) > 0) ?? amazon[0];
    if (!sample) {
      console.log('  no Amazon txn on page 1');
      continue;
    }
    console.log('  --- sample txn top-level keys ---');
    console.log('  ', Object.keys(sample).sort().join(', '));
    console.log('  id=%s amount=%s merchant=%s', sample.id, sample.amount, sample.merchant_name);
    console.log('  sync_status=%s state=%s', sample.sync_status, sample.state);
    console.log('  line_items:', JSON.stringify(sample.line_items));
    console.log('  receipts:', JSON.stringify(sample.receipts));
    const rid = sample.receipts?.[0];
    if (rid) {
      const r = await rampGet<Record<string, unknown>>(entity, `/receipts/${rid}`, token);
      console.log('  --- receipt HTTP %s keys ---', r.status);
      console.log('  ', Object.keys(r.body).sort().join(', '));
      const ocr = r.body['ocr'] as Record<string, unknown> | undefined;
      if (ocr) {
        console.log('  ocr keys:', Object.keys(ocr).sort().join(', '));
        console.log('  ocr.line_items:', JSON.stringify(ocr['line_items']).slice(0, 800));
        console.log('  ocr.taxes:', JSON.stringify(ocr['taxes']).slice(0, 400));
      } else {
        console.log('  NO ocr block on receipt');
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
