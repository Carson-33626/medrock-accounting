// Read-only: print the raw keys of one Amazon transaction so we can confirm the card-last-4 field name.
import './../ramp-split-push/load-env';
import { rampGet } from '../ramp-split-push/ramp-client';
import { rampToken } from '../amazon-enrich/client';
import type { Entity } from '../ramp-split-push/types';

async function main(): Promise<void> {
  const entity = (process.argv[2] as Entity) ?? 'FL';
  const token = await rampToken(entity, 'transactions:read');
  const { body } = await rampGet<{ data: Record<string, unknown>[] }>(entity, '/transactions?page_size=25&order_by_date_desc=true', token);
  const amz = (body.data ?? []).find((t) => /amazon/i.test(String((t as { merchant_name?: string }).merchant_name ?? '')));
  console.log('keys:', amz ? Object.keys(amz).sort() : 'no amazon txn on page 1');
  if (amz) console.log('card fields:', JSON.stringify({ card_id: amz['card_id'], card_last_four: amz['card_last_four'], card_holder: amz['card_holder'] }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
