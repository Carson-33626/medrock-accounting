// TopRx orchestrator: EXTRACT (roster + invoice PDFs -> resumable cache) then MATCH+PLAN against
// un-receipted Ramp TopRx card charges, then (only with --live) attach receipt + memo + split for
// matched+reconciled txns, capped at --limit. Dry-run by default: zero Ramp writes, only reads.
// Mirrors walmart-enrich/run-cdp.ts (extract) + run-cdp-split.ts (match/plan/write) collapsed into
// one per-entity pass since TopRx's roster + invoice PDF live behind the same authenticated page.
//   npx tsx scripts/receipt-capture/run-toprx.ts [--entity=FL] [--since 2025-09-01] [--live] [--limit 5]
import '../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { withTopRxPage } from './toprx-session';
import { scrapeTopRxRoster } from './toprx-roster';
import type { TopRxOrder } from './toprx-roster';
import { fetchTopRxInvoicePdf, parseTopRxInvoice } from './toprx-invoice';
import { buildVendorSplit } from './vendor-split';
import type { VendorParsed } from './vendor-split';
import { fetchWorklist } from './worklist';
import { matchOrders } from '../walmart-enrich/matcher';
import type { WalmartOrder } from '../walmart-enrich/matcher';
import { loadStore } from '../walmart-enrich/extraction-store';
import type { ExtractedOrder } from '../walmart-enrich/extraction-store';
import { attachReceipt } from '../walmart-enrich/ramp-receipts';
import { patchSplit, patchMemo } from '../amazon-enrich/client';
import { buildGlIndex } from '../amazon-enrich/gl-resolve';
import { rampToken } from '../ramp-split-push/ramp-client';
import { appendAudit } from './audit';
import type { Entity, RampTxn } from '../ramp-split-push/types';
import { ALL_ENTITIES } from '../ramp-split-push/types';

const OUT = 'scripts/receipt-capture/out';
const PDF_DIR = `${OUT}/pdf`;
const AUDIT_PATH = `${OUT}/receipt-capture-audit.csv`;
const VENDOR = 'toprx' as const;
const SCOPES_READ = 'transactions:read accounting:read';
const SCOPES_WRITE = 'transactions:read transactions:write memos:write receipts:write accounting:read';

// TopRx bills on net terms, not instant card-charge: a 2026-07-27 investigation against FL's real
// data (see task-6-report.md) found a median 31-day / max 54-day gap between the roster's
// order-creation date and the Ramp card charge date. matchOrders' walmart-derived default (3 days,
// right for a vendor that charges the card at purchase) produced ZERO matches here. 60 days covers
// the observed max with margin; order volume is low enough (~100/entity over 10 months) that the
// wider window does not introduce amount-collision ambiguity in practice.
const MATCH_WINDOW_DAYS = 60;

interface TopRxMatch { order: WalmartOrder; txn: RampTxn; matchedBy: 'parsed' | 'roster' }
interface TopRxMatchResult { confident: TopRxMatch[]; ambiguous: WalmartOrder[]; unmatched: WalmartOrder[] }

// Two-pass match: the parsed PDF invoice total is authoritative for matching to Ramp (per design),
// but a same-2026-07-27 investigation found 3 of 15 real order<->txn correspondences in FL data
// only equal ONE of the two totals — 2 only matched the parsed invoice, 1 only matched the roster
// grid's OrderTotal (the two disagree when the fetched invoice PDF doesn't cover an order's full
// billed amount, e.g. a partial/split-shipment invoice). Pass 1 matches on parsedTotalCents (any
// hit here reconciles by construction — safe for full read+write actions). Leftover orders/txns
// get a second pass on the roster's totalCents: a hit there IS a real order<->charge
// correspondence, but the invoice we captured does NOT reconcile with it, so downstream the
// reconcile gate skips all actions for these — surfaced for manual review rather than buried in
// "no_ramp_match".
function matchTopRxOrders(cached: ExtractedOrder[], worklist: RampTxn[], windowDays: number): TopRxMatchResult {
  const parsedList: WalmartOrder[] = cached.map((r) => ({ orderId: r.orderId, date: r.date, totalCents: r.parsedTotalCents }));
  const pass1 = matchOrders(parsedList, worklist, windowDays);
  const matchedIds = new Set(pass1.confident.map((m) => m.order.orderId));
  const usedTxnIds = new Set(pass1.confident.map((m) => m.txn.id));

  const leftoverCached = cached.filter((r) => !matchedIds.has(r.orderId));
  const rosterList: WalmartOrder[] = leftoverCached.map((r) => ({ orderId: r.orderId, date: r.date, totalCents: r.totalCents }));
  const leftoverWorklist = worklist.filter((t) => !usedTxnIds.has(t.id));
  const pass2 = matchOrders(rosterList, leftoverWorklist, windowDays);

  return {
    confident: [
      ...pass1.confident.map((m) => ({ ...m, matchedBy: 'parsed' as const })),
      ...pass2.confident.map((m) => ({ ...m, matchedBy: 'roster' as const })),
    ],
    ambiguous: pass2.ambiguous,
    unmatched: pass2.unmatched,
  };
}

interface Args { entities: Entity[]; since: string; live: boolean; limit: number }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  };
  const entityArg = get('--entity');
  const entities: Entity[] = entityArg ? [entityArg as Entity] : [...ALL_ENTITIES];
  for (const e of entities) {
    if (!ALL_ENTITIES.includes(e)) throw new Error(`Unknown --entity ${e as string} (expected FL, TN, or TX)`);
  }
  return {
    entities,
    since: get('--since') ?? '2025-09-01',
    live: argv.includes('--live'),
    limit: Number(get('--limit') ?? '5') || 5,
  };
}

function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toVendorParsed(rec: ExtractedOrder, invoiceNumber: string | null): VendorParsed {
  return {
    layout: null,
    source: null,
    order: invoiceNumber,
    glHint: null,
    items: rec.items.map((i) => ({ desc: i.desc, amountCents: i.amountCents, category: null })),
    taxCents: rec.taxCents,
    shippingCents: rec.shippingCents,
    tipCents: rec.tipCents,
    parsedTotalCents: rec.parsedTotalCents,
  };
}

interface PlanRow {
  orderId: string;
  invoiceNumber: string | null;
  txnId: string;
  txnDate: string;
  amountCents: number;
  matchedBy: 'parsed' | 'roster' | null;
  reconciles: boolean | null;
  codedLines: number | null;
  suspenseLines: number | null;
  memo: string | null;
  receiptFilename: string | null;
  plannedActions: string;
  mode: 'live' | 'dry_run';
  notes: string;
}

function planRowLine(r: PlanRow): string {
  return [
    r.orderId, r.invoiceNumber ?? '', r.txnId, r.txnDate,
    (r.amountCents / 100).toFixed(2),
    r.matchedBy ?? '',
    r.reconciles === null ? '' : (r.reconciles ? 'Y' : 'N'),
    r.codedLines === null ? '' : String(r.codedLines),
    r.suspenseLines === null ? '' : String(r.suspenseLines),
    r.memo ?? '', r.receiptFilename ?? '', r.plannedActions, r.mode, r.notes,
  ].map(csv).join(',');
}

async function extractEntity(entity: Entity, since: string, store: ReturnType<typeof loadStore>): Promise<{ roster: TopRxOrder[]; fetched: number; parseFailures: number }> {
  return withTopRxPage(entity, async (page) => {
    const roster = await scrapeTopRxRoster(page, { since });
    const inWindow = roster.filter((r) => r.date >= since);
    const missing = inWindow.filter((r) => !store.has(r.orderId));
    console.log(`[${entity}] roster: ${roster.length} order(s), ${inWindow.length} on/after ${since}, ${missing.length} to extract`);

    let fetched = 0;
    let parseFailures = 0;
    if (!existsSync(PDF_DIR)) mkdirSync(PDF_DIR, { recursive: true });
    for (const order of missing) {
      let pdf: Buffer;
      try {
        pdf = await fetchTopRxInvoicePdf(page, order.orderId);
      } catch (e) {
        console.error(`  [${entity}] ${order.orderId}: PDF fetch failed — ${(e as Error).message}`);
        continue;
      }
      const parsedPdf = await pdfParse(pdf);
      const parsed = parseTopRxInvoice(parsedPdf.text);
      if (!parsed) {
        console.error(`  [${entity}] ${order.orderId}: invoice text did not parse — skipping`);
        parseFailures++;
        continue;
      }
      const pdfPath = `${PDF_DIR}/toprx-${entity}-${order.orderId}.pdf`;
      writeFileSync(pdfPath, pdf);
      store.put({
        orderId: order.orderId,
        date: order.date,
        totalCents: order.totalCents,
        items: parsed.items.map((i) => ({ desc: i.desc, amountCents: i.amountCents })),
        taxCents: parsed.taxCents,
        shippingCents: parsed.shippingCents,
        tipCents: parsed.tipCents,
        parsedTotalCents: parsed.parsedTotalCents,
        pdfPath,
        fetchedAt: new Date().toISOString(),
      });
      fetched++;
      const recon = parsed.parsedTotalCents === order.totalCents;
      console.log(`  [${entity}] ${order.orderId} ${order.date} items=${parsed.items.length} parsed=$${(parsed.parsedTotalCents / 100).toFixed(2)} roster=$${(order.totalCents / 100).toFixed(2)} ${recon ? 'OK' : 'ROSTER-MISMATCH'}`);
    }
    return { roster, fetched, parseFailures };
  });
}

async function runEntity(entity: Entity, args: Args, runId: string): Promise<void> {
  const cachePath = `${OUT}/toprx-cache-${entity}.json`;
  const store = loadStore(cachePath);
  const { roster, fetched, parseFailures } = await extractEntity(entity, args.since, store);
  const invoiceByOrderId = new Map<string, string | null>(roster.map((o) => [o.orderId, o.invoiceNumber]));

  const token = await rampToken(entity, args.live ? SCOPES_WRITE : SCOPES_READ);
  const gl = await buildGlIndex(entity, token);
  const worklist = await fetchWorklist(VENDOR, entity, token);

  const cachedOrders: ExtractedOrder[] = store.all()
    .filter((r) => r.date >= args.since && r.totalCents > 0 && r.parsedTotalCents > 0);
  const match = matchTopRxOrders(cachedOrders, worklist, MATCH_WINDOW_DAYS);

  const rows: PlanRow[] = [];
  for (const o of match.ambiguous) {
    rows.push({
      orderId: o.orderId, invoiceNumber: invoiceByOrderId.get(o.orderId) ?? null,
      txnId: '', txnDate: '', amountCents: o.totalCents, matchedBy: null, reconciles: null,
      codedLines: null, suspenseLines: null, memo: null, receiptFilename: null,
      plannedActions: 'skip', mode: 'dry_run', notes: 'ambiguous_match',
    });
  }
  for (const o of match.unmatched) {
    rows.push({
      orderId: o.orderId, invoiceNumber: invoiceByOrderId.get(o.orderId) ?? null,
      txnId: '', txnDate: '', amountCents: o.totalCents, matchedBy: null, reconciles: null,
      codedLines: null, suspenseLines: null, memo: null, receiptFilename: null,
      plannedActions: 'skip', mode: 'dry_run', notes: 'no_ramp_match',
    });
  }

  let reconciled = 0;
  let liveWrites = 0;
  for (const m of match.confident) {
    const rec = store.get(m.order.orderId)!;
    const invoiceNumber = invoiceByOrderId.get(m.order.orderId) ?? null;
    const invoiceKey = invoiceNumber ?? m.order.orderId;
    const reconciles = rec.parsedTotalCents === m.txn.amountCents;
    if (reconciles) reconciled++;

    const memo = `TopRx invoice #${invoiceKey}, order #${m.order.orderId} (auto-captured)`;
    const receiptFilename = `TopRx-invoice-${invoiceKey}.pdf`;
    const idempotencyKey = `rcpcap-toprx-${m.txn.id}`;

    if (!reconciles) {
      const notes = m.matchedBy === 'roster'
        ? 'no_reconcile: matched via roster grid total, but parsed invoice PDF disagrees — likely a partial/split-shipment invoice; needs manual invoice review'
        : 'no_reconcile: parsedTotalCents != txn.amountCents';
      rows.push({
        orderId: m.order.orderId, invoiceNumber, txnId: m.txn.id, txnDate: m.txn.date,
        amountCents: m.txn.amountCents, matchedBy: m.matchedBy, reconciles, codedLines: null, suspenseLines: null,
        memo, receiptFilename, plannedActions: 'skip', mode: 'dry_run', notes,
      });
      if (args.live) appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'skip', invoiceKey, amountCents: m.txn.amountCents, status: null, detail: notes });
      continue;
    }
    if (!m.txn.userId) {
      rows.push({
        orderId: m.order.orderId, invoiceNumber, txnId: m.txn.id, txnDate: m.txn.date,
        amountCents: m.txn.amountCents, matchedBy: m.matchedBy, reconciles, codedLines: null, suspenseLines: null,
        memo, receiptFilename, plannedActions: 'skip', mode: 'dry_run', notes: 'missing_user_id',
      });
      if (args.live) appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'skip', invoiceKey, amountCents: m.txn.amountCents, status: null, detail: 'missing userId; receipts require it' });
      continue;
    }

    const built = buildVendorSplit(VENDOR, toVendorParsed(rec, invoiceNumber), m.txn.amountCents, gl);
    const plannedActions = built ? 'attach_receipt;memo;split' : 'attach_receipt;memo';
    const notes = built ? '' : 'split_build_failed';

    const executeLive = args.live && liveWrites < args.limit;
    const mode: 'live' | 'dry_run' = executeLive ? 'live' : 'dry_run';

    if (executeLive) {
      const pdfBuf = readFileSync(rec.pdfPath);
      const att = await attachReceipt(entity, m.txn.id, pdfBuf, receiptFilename, token, m.txn.userId, idempotencyKey);
      appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'attach_receipt', invoiceKey, amountCents: m.txn.amountCents, status: att.status, detail: JSON.stringify(att.body).slice(0, 500) });

      const memoRes = await patchMemo(entity, m.txn.id, memo, token);
      appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'memo', invoiceKey, amountCents: m.txn.amountCents, status: memoRes.status, detail: JSON.stringify(memoRes.body).slice(0, 500) });

      if (built) {
        const splitRes = await patchSplit(entity, m.txn.id, built.lines.map((l) => ({ amount: l.amount, memo: l.memo, accounting_field_selections: l.accounting_field_selections })), token);
        appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'split', invoiceKey, amountCents: m.txn.amountCents, status: splitRes.status, detail: JSON.stringify(splitRes.body).slice(0, 500) });
      } else {
        appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'skip', invoiceKey, amountCents: m.txn.amountCents, status: null, detail: 'split_build_failed (receipt+memo still applied)' });
      }
      liveWrites++;
    }

    rows.push({
      orderId: m.order.orderId, invoiceNumber, txnId: m.txn.id, txnDate: m.txn.date,
      amountCents: m.txn.amountCents, matchedBy: m.matchedBy, reconciles, codedLines: built?.codedCount ?? null,
      suspenseLines: built?.suspenseCount ?? null, memo, receiptFilename,
      plannedActions, mode, notes: mode === 'dry_run' && args.live ? 'over_limit' : notes,
    });
  }

  const planPath = `${OUT}/toprx-plan-${entity}.csv`;
  const header = 'order_id,invoice_number,txn_id,txn_date,amount,matched_by,reconciles,coded_lines,suspense_lines,memo,receipt_filename,planned_actions,mode,notes';
  writeFileSync(planPath, [header, ...rows.map(planRowLine)].join('\n') + '\n');

  const byParsed = match.confident.filter((m) => m.matchedBy === 'parsed').length;
  const byRoster = match.confident.filter((m) => m.matchedBy === 'roster').length;
  console.log(`[${entity}] roster=${roster.length} extracted=+${fetched} parseFailures=${parseFailures} cached=${store.all().length} | matched=${match.confident.length} (parsed-total=${byParsed}, roster-total-fallback=${byRoster}) ambiguous=${match.ambiguous.length} unmatched=${match.unmatched.length} | reconciled=${reconciled}/${match.confident.length} | ${args.live ? `live writes=${liveWrites} (limit ${args.limit})` : 'dry-run (no writes)'}`);
  console.log(`[${entity}] wrote ${planPath} (${rows.length} rows), cache ${cachePath}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const runId = `toprx-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`run ${runId} | entities=${args.entities.join(',')} | since=${args.since} | mode=${args.live ? `LIVE (limit ${args.limit})` : 'DRY-RUN'}`);
  for (const entity of args.entities) {
    await runEntity(entity, args, runId);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
