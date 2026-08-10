/**
 * READ-ONLY: dump the COMPLETE raw JSON of a few Amazon->Suspense write targets.
 *
 * WHY: `PATCH /transactions` replaces `line_items` wholesale — anything not re-sent is dropped.
 * The probe layer flattens selections into a display shape, which is fine for reporting but hides
 * the exact keys a round-trip needs (in particular the OPTION external id for each selection, and
 * how QuickbooksBillable / QuickbooksClass are represented). Guessing that payload is how you
 * silently destroy a Billable flag or an intercompany Class on 230 transactions.
 *
 * Prints raw JSON for a handful of real targets per entity, plus the resolved Suspense option id.
 *   NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/probe-ramp-amazon-rawshape.ts
 */
import './receipt-enrichment/engines/ramp-split-push/load-env';
import { rampToken, rampGet, getRampAccounts } from './receipt-enrichment/engines/ramp-split-push/ramp-client';
import type { Entity } from './receipt-enrichment/engines/ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const SCOPE = 'transactions:read accounting:read';
const SUSPENSE_CODE = '8220';

interface RawTxn {
  id: string;
  amount?: number | null;
  sync_status?: string | null;
  merchant_name?: string | null;
  user_transaction_time?: string | null;
  memo?: string | null;
  accounting_field_selections?: unknown;
  line_items?: unknown;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, SCOPE);

    const accounts = await getRampAccounts(entity, token);
    const suspense = accounts.find((a) => (a as { code?: string }).code === SUSPENSE_CODE);
    console.log(`\n================ ${entity} ================`);
    console.log(`Suspense account object: ${JSON.stringify(suspense)}`);

    // Pull pages until we have a few Amazon NOT_SYNC_READY targets not already at Suspense.
    const targets: RawTxn[] = [];
    let url = '/transactions?page_size=100';
    for (let page = 0; page < 30 && targets.length < 3; page++) {
      const res = await rampGet<Page>(entity, url, token);
      for (const t of res.body.data ?? []) {
        if (t.merchant_name !== 'Amazon') continue;
        if (t.sync_status !== 'NOT_SYNC_READY') continue;
        const blob = JSON.stringify(t);
        if (blob.includes('"8220"')) continue; // already Suspense — not a target
        targets.push(t);
        if (targets.length >= 3) break;
      }
      const next = res.body.page?.next;
      if (!next) break;
      url = next;
    }

    console.log(`  ${targets.length} sample target(s):`);
    for (const t of targets) {
      console.log(`\n  --- txn ${t.id}  ${t.user_transaction_time ?? ''}  $${t.amount} ---`);
      console.log(`  txn-level selections: ${JSON.stringify(t.accounting_field_selections, null, 2)}`);
      console.log(`  line_items:           ${JSON.stringify(t.line_items, null, 2)}`);
      console.log(`  memo:                 ${JSON.stringify(t.memo)}`);
    }
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
