// RECON SPLIT: the charge-level pipeline. Pair each un-enriched Ramp Amazon txn to an Amazon
// "Transactions report" charge (which carries the Order ID), fetch that order's GENUINE invoice PDF
// (real order-document.pdf, with a text layer), parse its line items, build the itemized split, attach
// the real invoice as the receipt, and PATCH. Handles the case the order-level Items report could not:
// batched charges. Dry-run default; --live is capped + reversible (rollback.json).
//   npx tsx scripts/amazon-csv-enrich/run-recon-split.ts [--from 2026-04-01 --to 2026-05-31] [--live] [--cap N] [--ramp-pages 260]
import './../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { parseCsvRows } from './csv-parser';
import { unwrapExcel, parseMoneyCents, parseMDY } from './csv-fields';
import { matchCharges } from './matcher';
import { withAmazonPage } from './amazon-cdp';
import { switchToBusiness, BUSINESS_BY_ACCOUNT } from './account-switcher';
import { fetchRealInvoice } from './invoice-fetch';
import { parseInvoiceText } from './invoice-parse';
import { getUnenrichedAmazonTxns, patchSplit, rampToken } from './client';
import { buildGlIndex } from '../amazon-enrich/gl-resolve';
import type { GlIndex } from '../amazon-enrich/gl-resolve';
import { buildSplit } from '../amazon-enrich/split';
import { attachReceipt } from '../walmart-enrich/ramp-receipts';
import type { ParsedReceipt } from '../amazon-enrich/receipt-parser';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity, RampTxn } from '../ramp-split-push/types';
import type { AmazonCharge } from './types';

const ROOT = 'scripts/amazon-csv-enrich/out';
const OUT = `${ROOT}/_recon`;
const SCOPES_READ = 'transactions:read accounting:read';
const SCOPES_WRITE = 'transactions:read transactions:write receipts:write accounting:read';
function argVal(f: string, d: string): string { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const has = (f: string): boolean => process.argv.includes(f);
function csv(v: unknown): string { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const inWin = (d: string, from: string, to: string): boolean => (!from || d >= from) && (!to || d <= to);

// One charge per Payment Reference ID, tagged with the source account (= the Amazon Business it was
// downloaded under, i.e. which business can see the order for the invoice fetch).
function parseTxnReport(text: string, account: string): (AmazonCharge & { account: string })[] {
  const byRef = new Map<string, AmazonCharge & { account: string }>();
  for (const r of parseCsvRows(text)) {
    if ((unwrapExcel(r['Transaction Type'] ?? '')).toLowerCase() !== 'charge') continue;
    const paymentRef = unwrapExcel(r['Payment Reference ID'] ?? '');
    if (!paymentRef) continue;
    const orderId = unwrapExcel(r['Order ID'] ?? '');
    let c = byRef.get(paymentRef);
    if (!c) {
      const cents = parseMoneyCents(r['Payment Amount'] ?? '');
      c = { paymentRef, orderIds: [], primaryOrderId: orderId, accountGroup: unwrapExcel(r['Account Group'] ?? ''),
        chargeCents: cents, payDate: parseMDY(r['Transaction Date'] ?? ''), cardLast4: null, items: [], itemsTotalCents: cents, account };
      byRef.set(paymentRef, c);
    }
    if (orderId && !c.orderIds.includes(orderId)) c.orderIds.push(orderId);
    if (!c.primaryOrderId && orderId) c.primaryOrderId = orderId;
  }
  return [...byRef.values()];
}

async function main(): Promise<void> {
  const from = argVal('--from', ''), to = argVal('--to', '');
  const live = has('--live');
  const cap = Number(argVal('--cap', '0')) || 0;
  const pages = Number(argVal('--ramp-pages', '260')) || 260;
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  // Pool charges (dedupe by paymentRef, keep source account) from all transactions reports.
  const byRef = new Map<string, AmazonCharge & { account: string }>();
  for (const a of readdirSync(ROOT).filter((d) => !d.startsWith('_'))) {
    const p = `${ROOT}/${a}/transactions.csv`;
    if (!existsSync(p)) continue;
    for (const c of parseTxnReport(readFileSync(p, 'utf8'), a)) if (!byRef.has(c.paymentRef)) byRef.set(c.paymentRef, c);
  }
  const charges = [...byRef.values()];
  const acctOfRef = new Map(charges.map((c) => [c.paymentRef, c.account] as const));

  // Ramp pool + per-entity token/GL.
  const token: Record<Entity, string> = {} as Record<Entity, string>;
  const gl: Record<Entity, GlIndex> = {} as Record<Entity, GlIndex>;
  const pool: RampTxn[] = [];
  for (const e of ALL_ENTITIES) {
    token[e] = await rampToken(e, live ? SCOPES_WRITE : SCOPES_READ);
    gl[e] = await buildGlIndex(e, token[e]);
    pool.push(...await getUnenrichedAmazonTxns(e, token[e], pages));
  }
  let confident = matchCharges(charges, pool).confident;
  if (from || to) confident = confident.filter((m) => inWin(m.txn.date, from, to));
  console.log(`pairs to process: ${confident.length}${from || to ? ` (window ${from}..${to})` : ''}`);

  // Group by source account so we switch business once per group.
  const byAccount = new Map<string, typeof confident>();
  for (const m of confident) { const a = acctOfRef.get(m.charge.paymentRef) ?? 'FL'; const l = byAccount.get(a) ?? []; l.push(m); byAccount.set(a, l); }

  const preview: string[] = ['order_id,txn_id,entity,txn_date,charge,line_desc,split_amount,gl_name,coded,mode'];
  const aside: string[] = ['order_id,txn_id,charge,reason,detail'];
  const rollback: { entity: Entity; txn_id: string; order_id: string; prior_line_items: unknown }[] = [];
  let writes = 0, attachFails = 0, done = 0;

  await withAmazonPage(async (page) => {
    for (const [account, pairs] of byAccount) {
      if (cap && writes >= cap && live) break;
      const business = BUSINESS_BY_ACCOUNT[account] || '';
      if (business) { console.log(`[${account}] switching to "${business}" (${pairs.length} pairs)...`); await switchToBusiness(page, business); }
      for (const m of pairs) {
        const order = m.charge.primaryOrderId;
        const charge = m.txn.amountCents;
        try {
          const { pdf, text } = await fetchRealInvoice(page, order);
          const inv = parseInvoiceText(text);
          if (inv.grandTotalCents !== charge) { aside.push([order, m.txn.id, (charge / 100).toFixed(2), 'multi_charge_order', `grand=${inv.grandTotalCents} ships=[${inv.shipmentTotalsCents}]`].map(csv).join(',')); await sleep(900); continue; }
          if (!inv.items.length) { aside.push([order, m.txn.id, (charge / 100).toFixed(2), 'no_items_parsed', ''].map(csv).join(',')); await sleep(900); continue; }
          const parsed: ParsedReceipt = { layout: 'AMZ', source: 'amazon-csv', order, glHint: null,
            items: inv.items.map((i) => ({ desc: i.desc, amountCents: i.amountCents })),
            taxCents: inv.grandTotalCents - inv.itemsSubtotalCents, shippingCents: 0, tipCents: 0, parsedTotalCents: inv.grandTotalCents };
          const built = buildSplit(parsed, charge, gl[m.txn.entity]);
          if (!built || built.lines.some((l) => l.amount <= 0)) { aside.push([order, m.txn.id, (charge / 100).toFixed(2), 'build_fail', built ? 'nonpositive_line' : 'null'].map(csv).join(',')); await sleep(900); continue; }

          const capped = live && cap > 0 && writes >= cap;
          const mode = live && !capped ? 'live' : 'dry_run';
          if (mode === 'live') {
            const res = await patchSplit(m.txn.entity, m.txn.id, built.lines.map((l) => ({ amount: l.amount, memo: l.memo, accounting_field_selections: l.accounting_field_selections })), token[m.txn.entity]);
            if (res.status < 200 || res.status >= 300) { aside.push([order, m.txn.id, (charge / 100).toFixed(2), 'write_fail', `HTTP ${res.status}`].map(csv).join(',')); await sleep(900); continue; }
            if (!m.txn.userId) { aside.push([order, m.txn.id, (charge / 100).toFixed(2), 'attach_fail', 'no user_id'].map(csv).join(',')); attachFails++; }
            else {
              const att = await attachReceipt(m.txn.entity, m.txn.id, pdf, `amazon-${order}.pdf`, token[m.txn.entity], m.txn.userId, `amazon-recon-receipt-${order}`);
              if (att.status < 200 || att.status >= 300) { aside.push([order, m.txn.id, (charge / 100).toFixed(2), 'attach_fail', `HTTP ${att.status}`].map(csv).join(',')); attachFails++; }
            }
            writes++;
            rollback.push({ entity: m.txn.entity, txn_id: m.txn.id, order_id: order, prior_line_items: m.txn.priorLineItems });
          }
          for (const l of built.lines) preview.push([order, m.txn.id, m.txn.entity, m.txn.date, (charge / 100).toFixed(2), l.desc, (l.amount / 100).toFixed(2), l.glName ?? '', String(l.coded), mode].map(csv).join(','));
          done++;
        } catch (e) { aside.push([order, m.txn.id, (charge / 100).toFixed(2), 'fetch_or_parse_fail', (e as Error).message].map(csv).join(',')); }
        await sleep(1000);
      }
    }
  });

  writeFileSync(`${OUT}/recon_preview.csv`, preview.join('\n'));
  writeFileSync(`${OUT}/recon_set_aside.csv`, aside.join('\n'));
  if (rollback.length) {
    const path = `${OUT}/recon_rollback.json`;
    const prior: typeof rollback = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    const seen = new Set(prior.map((r) => r.txn_id));
    writeFileSync(path, JSON.stringify([...prior, ...rollback.filter((r) => !seen.has(r.txn_id))], null, 2));
  }
  console.log(`\nMODE: ${live ? `LIVE (cap ${cap || '∞'}, ${writes} written, ${attachFails} attach-fail)` : 'DRY-RUN (no writes)'}`);
  console.log(`processed ${done} pairs -> ${preview.length - 1} split lines | set-aside ${aside.length - 1}`);
  console.log(`Wrote ${OUT}/recon_preview.csv, ${OUT}/recon_set_aside.csv${rollback.length ? `, ${OUT}/recon_rollback.json (+${rollback.length})` : ''}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
