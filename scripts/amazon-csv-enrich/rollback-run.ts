// Reverse a live SPLIT run: reset each written transaction's line_items back to Ramp's default single
// line (PATCH line_items:[] — the documented rollback), which also un-enriches it so a corrected re-run
// can re-target it. Reads out/_split/rollback.json. Dry-run default; --live actually reverses.
//   npx tsx scripts/amazon-csv-enrich/rollback-run.ts [--live] [--txns id1,id2]
// NOTE: attached receipts CANNOT be removed via the Ramp API — delete those in the Ramp UI if needed.
import './../ramp-split-push/load-env';
import { existsSync, readFileSync } from 'node:fs';
import { patchSplit, patchMemo, rampToken } from './client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

const RB = 'scripts/amazon-csv-enrich/out/_split/rollback.json';
const has = (flag: string): boolean => process.argv.includes(flag);
function argVal(flag: string): string | null { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null; }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RbEntry { entity: Entity; txn_id: string; payment_ref: string; prior_line_items: unknown; }

async function main(): Promise<void> {
  const live = has('--live');
  const only = new Set((argVal('--txns')?.split(',').map((s) => s.trim()).filter(Boolean)) ?? []);
  if (!existsSync(RB)) throw new Error(`No rollback ledger at ${RB}.`);
  let entries = JSON.parse(readFileSync(RB, 'utf8')) as RbEntry[];
  if (only.size) entries = entries.filter((e) => only.has(e.txn_id));
  if (!entries.length) { console.log('nothing to roll back'); return; }

  const token: Partial<Record<Entity, string>> = {};
  if (live) for (const e of ALL_ENTITIES) token[e] = await rampToken(e, 'transactions:read transactions:write');

  let ok = 0, fail = 0;
  for (const e of entries) {
    if (!live) { console.log(`DRY reset ${e.entity} ${e.txn_id} (ref ${e.payment_ref})`); continue; }
    const tok = token[e.entity];
    if (!tok) { console.error(`  ${e.txn_id}: no token for ${e.entity}`); fail++; continue; }
    const res = await patchSplit(e.entity, e.txn_id, [], tok); // [] -> Ramp restores the default single line
    await patchMemo(e.entity, e.txn_id, '', tok).catch(() => undefined); // best-effort clear of our txn memo
    if (res.status >= 200 && res.status < 300) { ok++; console.log(`  reset ${e.entity} ${e.txn_id} (HTTP ${res.status})`); }
    else { fail++; console.error(`  ${e.txn_id}: reset FAILED HTTP ${res.status}`); }
    await sleep(400);
  }
  console.log(`\n${live ? 'LIVE' : 'DRY-RUN'}: ${entries.length} target(s)${live ? ` | ${ok} reset, ${fail} failed` : ''}`);
  if (live) console.log('Reminder: receipts are not API-removable — delete any stale receipts in the Ramp UI.');
}
main().catch((e) => { console.error(e); process.exit(1); });
