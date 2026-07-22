// SPLIT (global, one run across all logins): pool the per-login extraction caches, match each charge to
// an un-enriched Ramp Amazon txn (amount+date+last4), build the itemized split from CSV data, and attach
// the cached Amazon invoice PDF + PATCH the split. Dry-run default; --live is capped + reversible.
//   npx tsx scripts/amazon-csv-enrich/run-split.ts [--accounts fl,tx,grp1] [--ramp-pages 60] [--live] [--cap N]
import './../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { loadChargeStore } from './extraction-store';
import type { CachedCharge } from './extraction-store';
import { matchCharges } from './matcher';
import { chargeToParsed } from './split-adapter';
import { getUnenrichedAmazonTxns, patchSplit, rampToken } from './client';
import { buildGlIndex } from '../amazon-enrich/gl-resolve';
import type { GlIndex } from '../amazon-enrich/gl-resolve';
import { buildSplit } from '../amazon-enrich/split';
import { attachReceipt } from '../walmart-enrich/ramp-receipts';
import { buildReceiptPdf } from '../walmart-enrich/receipt-pdf';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity, RampTxn } from '../ramp-split-push/types';

const ROOT = 'scripts/amazon-csv-enrich/out';
const OUT = `${ROOT}/_split`;
const SCOPES_READ = 'transactions:read accounting:read';
const SCOPES_WRITE = 'transactions:read transactions:write receipts:write accounting:read';

function argVal(flag: string): string | null { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null; }
const has = (flag: string): boolean => process.argv.includes(flag);
function csv(v: unknown): string { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

function discoverAccounts(): string[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '_split').map((d) => d.name);
}

async function main(): Promise<void> {
  const live = has('--live');
  const cap = Number(argVal('--cap') ?? '0') || 0;
  const rampPages = Number(argVal('--ramp-pages') ?? '60') || 60;
  const accounts = (argVal('--accounts')?.split(',').map((s) => s.trim()).filter(Boolean)) ?? discoverAccounts();
  if (!accounts.length) throw new Error(`No extraction caches under ${ROOT}. Run run-extract.ts first.`);
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  // Pool + dedupe charges across logins.
  const byRef = new Map<string, CachedCharge>();
  for (const a of accounts) {
    const path = `${ROOT}/${a}/charges.json`;
    if (!existsSync(path)) { console.log(`  (skip ${a}: no charges.json)`); continue; }
    for (const rec of loadChargeStore(path).all()) if (!byRef.has(rec.charge.paymentRef)) byRef.set(rec.charge.paymentRef, rec);
  }
  const cached = [...byRef.values()];
  console.log(`pooled ${cached.length} charges from accounts: ${accounts.join(', ')}`);

  // Pool Ramp txns across entities; keep per-entity token + GL index.
  const token: Record<Entity, string> = {} as Record<Entity, string>;
  const gl: Record<Entity, GlIndex> = {} as Record<Entity, GlIndex>;
  const pooledTxns: RampTxn[] = [];
  for (const e of ALL_ENTITIES) {
    token[e] = await rampToken(e, live ? SCOPES_WRITE : SCOPES_READ);
    gl[e] = await buildGlIndex(e, token[e]);
    const txns = await getUnenrichedAmazonTxns(e, token[e], rampPages);
    pooledTxns.push(...txns);
    console.log(`  ${e}: ${txns.length} un-enriched Amazon txns`);
  }

  const charges = cached.map((r) => r.charge);
  const match = matchCharges(charges, pooledTxns);
  const pdfByRef = new Map(cached.map((r) => [r.charge.paymentRef, r.invoicePdfPath] as const));

  const preview: string[] = ['payment_ref,order_id,txn_id,entity,txn_date,amount,line_desc,split_amount,gl_name,confidence,coded,mode'];
  const aside: string[] = ['payment_ref,order_id,reason,detail'];
  const rollback: { entity: Entity; txn_id: string; payment_ref: string; prior_line_items: unknown }[] = [];
  for (const c of match.ambiguous) aside.push([c.paymentRef, c.primaryOrderId, 'ambiguous_match', `amt=${(c.chargeCents / 100).toFixed(2)}`].map(csv).join(','));
  for (const c of match.unmatched) aside.push([c.paymentRef, c.primaryOrderId, 'no_ramp_match', `amt=${(c.chargeCents / 100).toFixed(2)}`].map(csv).join(','));

  let writes = 0, attachFails = 0;
  for (const m of match.confident) {
    const c = m.charge;
    if (c.itemsTotalCents !== m.txn.amountCents) { aside.push([c.paymentRef, c.primaryOrderId, 'no_reconcile', `items=${c.itemsTotalCents} txn=${m.txn.amountCents}`].map(csv).join(',')); continue; }
    const built = buildSplit(chargeToParsed(c), m.txn.amountCents, gl[m.txn.entity]);
    if (!built) { aside.push([c.paymentRef, c.primaryOrderId, 'build_fail', ''].map(csv).join(',')); continue; }

    const capped = live && cap > 0 && writes >= cap;
    const mode = live && !capped ? 'live' : 'dry_run';
    if (mode === 'live') {
      const res = await patchSplit(m.txn.entity, m.txn.id, built.lines.map((l) => ({ amount: l.amount, memo: l.memo, accounting_field_selections: l.accounting_field_selections })), token[m.txn.entity]);
      if (res.status < 200 || res.status >= 300) { aside.push([c.paymentRef, c.primaryOrderId, 'write_fail', `HTTP ${res.status}`].map(csv).join(',')); continue; }
      // Attach the cached Amazon invoice PDF; fall back to a generated itemized PDF if missing.
      const cachedPdf = pdfByRef.get(c.paymentRef);
      const pdf = cachedPdf && existsSync(cachedPdf)
        ? readFileSync(cachedPdf)
        : Buffer.from(await buildReceiptPdf({ orderId: c.primaryOrderId, date: c.payDate, totalCents: c.chargeCents, items: c.items, taxCents: 0, shippingCents: 0, tipCents: 0, parsedTotalCents: c.itemsTotalCents, pdfPath: '', fetchedAt: '' }));
      if (!m.txn.userId) { aside.push([c.paymentRef, c.primaryOrderId, 'attach_fail', 'no user_id'].map(csv).join(',')); attachFails++; }
      else {
        const att = await attachReceipt(m.txn.entity, m.txn.id, pdf, `amazon-${c.primaryOrderId}.pdf`, token[m.txn.entity], m.txn.userId, `amazon-csv-receipt-${c.primaryOrderId}`);
        if (att.status < 200 || att.status >= 300) { aside.push([c.paymentRef, c.primaryOrderId, 'attach_fail', `HTTP ${att.status}`].map(csv).join(',')); attachFails++; }
      }
      writes++;
      rollback.push({ entity: m.txn.entity, txn_id: m.txn.id, payment_ref: c.paymentRef, prior_line_items: m.txn.priorLineItems });
    }
    for (const l of built.lines) {
      preview.push([c.paymentRef, c.primaryOrderId, m.txn.id, m.txn.entity, m.txn.date, (m.txn.amountCents / 100).toFixed(2), l.desc, (l.amount / 100).toFixed(2), l.glName, l.confidence, l.coded, mode].map(csv).join(','));
    }
  }

  writeFileSync(`${OUT}/preview_splits.csv`, preview.join('\n'));
  writeFileSync(`${OUT}/set_aside.csv`, aside.join('\n'));
  if (rollback.length) {
    const path = `${OUT}/rollback.json`;
    const prior: typeof rollback = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    const seen = new Set(prior.map((r) => r.txn_id));
    writeFileSync(path, JSON.stringify([...prior, ...rollback.filter((r) => !seen.has(r.txn_id))], null, 2));
  }
  console.log(`\nMODE: ${live ? `LIVE (cap ${cap || '∞'}, ${writes} written, ${attachFails} attach-fail)` : 'DRY-RUN (no writes)'}`);
  console.log(`charges ${charges.length} | confident ${match.confident.length} | ambiguous ${match.ambiguous.length} | unmatched ${match.unmatched.length}`);
  console.log(`Wrote ${OUT}/preview_splits.csv (${preview.length - 1}), ${OUT}/set_aside.csv (${aside.length - 1})${rollback.length ? `, ${OUT}/rollback.json (+${rollback.length})` : ''}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
