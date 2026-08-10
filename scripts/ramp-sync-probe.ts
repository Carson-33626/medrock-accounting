// READ-ONLY probe: what sync/approval fields does the Ramp txn payload expose?
// Run from web/ dir:  npx tsx scripts/ramp-sync-probe.ts
import './receipt-enrichment/engines/ramp-split-push/load-env';
import { rampToken, rampGet } from './receipt-enrichment/engines/ramp-split-push/ramp-client';

interface Page { data: Record<string, unknown>[] }

async function main(): Promise<void> {
  const token = await rampToken('FL', 'transactions:read');
  const { body } = await rampGet<Page>('FL', '/transactions?page_size=5&order_by_date_desc=true', token);
  const t = body.data[0];
  console.log('KEYS:', Object.keys(t).sort().join(', '));
  for (const k of ['sync_status', 'accounting_date', 'settlement_date', 'all_requirements_met_and_approved', 'state', 'user_transaction_time']) {
    console.log(`${k}:`, JSON.stringify(t[k]));
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
