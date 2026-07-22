// READ-ONLY: of the April+May Amazon txns still needing work, how many can the tooling auto-process
// (a confident CSV-charge match) vs how many are manual-only? Uses the real matcher against a DEEP
// un-enriched pool so April/May txns are actually included.
//   npx tsx scripts/amazon-csv-enrich/analyze-apr-may.ts [--from 2026-04-01] [--to 2026-05-31] [--pages 260]
import './../ramp-split-push/load-env';
import { existsSync, readdirSync } from 'node:fs';
import { loadChargeStore } from './extraction-store';
import { matchCharges } from './matcher';
import { getUnenrichedAmazonTxns, rampToken } from './client';
import { sharedPdfPath } from './paths';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity, RampTxn } from '../ramp-split-push/types';
import type { AmazonCharge } from './types';

const ROOT = 'scripts/amazon-csv-enrich/out';
function argVal(flag: string, def: string): string { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; }
const inWindow = (d: string, from: string, to: string): boolean => d >= from && d <= to;

async function main(): Promise<void> {
  const from = argVal('--from', '2026-04-01');
  const to = argVal('--to', '2026-05-31');
  const pages = Number(argVal('--pages', '260')) || 260;

  const charges: AmazonCharge[] = [];
  const seen = new Set<string>();
  for (const a of existsSync(ROOT) ? readdirSync(ROOT).filter((d) => d !== '_split' && d !== '_audit') : []) {
    const p = `${ROOT}/${a}/charges.json`;
    if (!existsSync(p)) continue;
    for (const rec of loadChargeStore(p).all()) if (!seen.has(rec.charge.paymentRef)) { seen.add(rec.charge.paymentRef); charges.push(rec.charge); }
  }

  const pool: RampTxn[] = [];
  for (const e of ALL_ENTITIES) {
    const txns = await getUnenrichedAmazonTxns(e, await rampToken(e, 'transactions:read'), pages);
    pool.push(...txns);
    const inWin = txns.filter((t) => inWindow(t.date, from, to)).length;
    console.log(`  ${e}: ${txns.length} un-enriched Amazon txns (${inWin} in ${from}..${to})`);
  }

  const { confident, ambiguous, unmatched } = matchCharges(charges, pool);
  // Un-enriched April/May txns = the "needs work" universe (matches audit NEEDS_* + any receipt-only-missing).
  const windowPool = pool.filter((t) => inWindow(t.date, from, to));
  const confidentTxnIds = new Set(confident.map((m) => m.txn.id));
  const matchable = windowPool.filter((t) => confidentTxnIds.has(t.id));
  const notMatchable = windowPool.filter((t) => !confidentTxnIds.has(t.id));
  const withInvoice = matchable.filter((t) => {
    const c = confident.find((m) => m.txn.id === t.id)?.charge;
    return c ? existsSync(sharedPdfPath(c.primaryOrderId)) : false;
  }).length;
  const sum = (xs: RampTxn[]): string => `$${xs.reduce((s, t) => s + t.amountCents / 100, 0).toFixed(2)}`;

  console.log(`\n=== April+May un-enriched Amazon: ${windowPool.length} txns (${sum(windowPool)}) ===`);
  console.log(`  tooling CAN process (confident match):  ${matchable.length}  (${sum(matchable)})  [${withInvoice} already have a cached invoice]`);
  console.log(`  manual-only (no confident CSV match):   ${notMatchable.length}  (${sum(notMatchable)})`);
  console.log(`\n(whole-window totals — confident ${confident.length}, ambiguous ${ambiguous.length}, unmatched ${unmatched.length})`);
  // Emit the matchable April/May txn ids so a targeted --txns live run can process exactly them.
  console.log(`\nmatchable April/May txn ids:\n${matchable.map((t) => t.id).join(',')}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
