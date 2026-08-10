// Read-only one-off: print the raw shape of a Ramp transaction's line_items so the verification probe
// parses `amount` correctly instead of guessing.
import './../ramp-split-push/load-env';
import { readFileSync } from 'node:fs';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';
import { WM } from '../../paths';

interface RollbackRow { entity: Entity; txn_id: string }

async function main(): Promise<void> {
  const rows = JSON.parse(readFileSync(`${WM.out}/sams/rollback.json`, 'utf8')) as RollbackRow[];
  const r = rows[0];
  const token = await rampToken(r.entity, 'transactions:read receipts:read accounting:read');
  const { body } = await rampGet<Record<string, unknown>>(r.entity, `/transactions/${r.txn_id}`, token);
  console.log('amount:', JSON.stringify(body.amount));
  console.log('receipts:', JSON.stringify(body.receipts));
  const lines = body.line_items as unknown[];
  console.log(`line_items: ${lines.length}`);
  console.log(JSON.stringify(lines[0], null, 2).slice(0, 1200));
}
main().catch((e) => { console.error(e); process.exit(1); });
