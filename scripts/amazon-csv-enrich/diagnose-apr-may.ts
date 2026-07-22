// READ-ONLY: for each un-enriched April/May Amazon txn, WHY doesn't the tooling process it? Categorize:
//   NO_CSV_CHARGE  = no CSV charge with matching amount+date (non-Business Amazon; nothing to attach)
//   CONTESTED      = a candidate charge exists but is shared with other txns (matcher won't guess)
//   RECONCILE_GAP  = single candidate but items != txn amount (partial fulfillment)
import './../ramp-split-push/load-env';
import { existsSync, readdirSync } from 'node:fs';
import { loadChargeStore } from './extraction-store';
import { getUnenrichedAmazonTxns, rampToken } from './client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity, RampTxn } from '../ramp-split-push/types';
import type { AmazonCharge } from './types';

const ROOT = 'scripts/amazon-csv-enrich/out';
function argVal(f: string, d: string): string { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; }
function days(a: string, b: string): number { const ms = Math.abs(new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()); return Number.isFinite(ms) ? Math.round(ms / 86400000) : 1e9; }

async function main(): Promise<void> {
  const from = argVal('--from', '2026-04-01'), to = argVal('--to', '2026-05-31');
  const pages = Number(argVal('--pages', '260')) || 260;
  const charges: AmazonCharge[] = [];
  const seen = new Set<string>();
  for (const a of readdirSync(ROOT).filter((d) => d !== '_split' && d !== '_audit')) {
    const p = `${ROOT}/${a}/charges.json`;
    if (!existsSync(p)) continue;
    for (const rec of loadChargeStore(p).all()) if (!seen.has(rec.charge.paymentRef)) { seen.add(rec.charge.paymentRef); charges.push(rec.charge); }
  }
  const pool: RampTxn[] = [];
  for (const e of ALL_ENTITIES) pool.push(...await getUnenrichedAmazonTxns(e, await rampToken(e, 'transactions:read'), pages));
  const win = pool.filter((t) => t.date >= from && t.date <= to);

  // candidate charges per txn (amount + date window), and how many txns each charge is a candidate for.
  const candCharges = (t: RampTxn): AmazonCharge[] => charges.filter((c) => c.chargeCents === t.amountCents && c.payDate && days(c.payDate, t.date) <= 3);
  const claim = new Map<string, number>();
  for (const t of win) for (const c of candCharges(t)) claim.set(c.paymentRef, (claim.get(c.paymentRef) ?? 0) + 1);

  let noCsv = 0, contested = 0, reconcileGap = 0, cleanSingle = 0;
  let noCsvAmt = 0;
  for (const t of win) {
    const cands = candCharges(t);
    if (cands.length === 0) { noCsv++; noCsvAmt += t.amountCents / 100; continue; }
    if (cands.length > 1) { contested++; continue; }
    const c = cands[0];
    if ((claim.get(c.paymentRef) ?? 0) > 1) { contested++; continue; }      // charge also claimed by another txn
    if (c.itemsTotalCents !== t.amountCents) { reconcileGap++; continue; }   // partial fulfillment
    cleanSingle++;                                                          // SHOULD have matched — investigate
  }
  console.log(`April/May un-enriched Amazon txns: ${win.length}`);
  console.log(`  NO_CSV_CHARGE (non-Business Amazon; no receipt data): ${noCsv}  ($${noCsvAmt.toFixed(2)})`);
  console.log(`  CONTESTED (candidate exists but shared/ambiguous):    ${contested}`);
  console.log(`  RECONCILE_GAP (single candidate, items != amount):    ${reconcileGap}`);
  console.log(`  CLEAN_SINGLE (should have auto-matched — investigate):${cleanSingle}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
