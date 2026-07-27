// ULINE orchestrator: EXTRACT (roster + invoice PDFs -> resumable cache) then MATCH+PLAN against
// un-receipted Ramp ULINE card charges, then (only with --live) attach receipt + memo + split for
// matched+reconciled txns, capped at --limit. Dry-run by default: zero Ramp writes, only reads.
// Mirrors run-toprx.ts's extract/match/plan/write shape; the differences below are dictated by
// ULINE's actual surface (session storageState instead of CDP-attach, per-entity account identity
// that must be verified rather than assumed, no order-level total anywhere except the parsed PDF).
//   npx tsx scripts/receipt-capture/run-uline.ts --entity=FL [--since 2025-09-01] [--live] [--limit 5] [--csv path/to/MyOrderHistory.csv] [--window 3]
import '../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { withUlineContext } from './uline-session';
import { scrapeUlineRoster, fetchUlineInvoicePdf, getUlineAccountName } from './uline-cdp';
import type { UlineInvoice } from './uline-cdp';
import { parseUlineInvoice, enrichCategories } from './uline-parser';
import type { UlineCsvRow } from './uline-parser';
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
const VENDOR = 'uline' as const;
const SCOPES_READ = 'transactions:read accounting:read';
const SCOPES_WRITE = 'transactions:read transactions:write memos:write receipts:write accounting:read';

// Observed live 2026-07-27 (FL account, MyOrderHistory #CompanyName header). TN/TX have no
// observed default and no bootstrap session yet — hard-stop rather than guess.
const DEFAULT_ACCOUNT_NAME: Partial<Record<Entity, string>> = { FL: 'MEDROCK PHARMACY' };

const DEFAULT_WINDOW_DAYS = 3;
const WINDOW_CONFIRM_THRESHOLD = 10;

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime());
  return Math.round(ms / 86400000);
}

// Collision guard, same reasoning as run-toprx.ts's hasSameTotalCompetitor: matchOrders only ever
// sees invoices reachable through the Ramp worklist (txns still missing a receipt). If a different
// invoice for this entity already has its receipt attached, its charge is invisible to the
// worklist, and the matcher can't learn it exists — so if that invisible invoice happens to share
// the parsed total (within the match window) of the invoice actually being matched, the matcher
// would confidently pair the one visible txn with whichever invoice it saw first. ULINE has only
// one total field (parsedTotalCents — no roster-level total exists to branch on), so this is
// simpler than the TopRx version: always compare on parsedTotalCents against the FULL entity cache.
function hasSameTotalCompetitor(
  allOrders: ExtractedOrder[],
  matchedInvoiceNumber: string,
  txnDate: string,
  windowDays: number,
): boolean {
  const target = allOrders.find((o) => o.orderId === matchedInvoiceNumber);
  if (!target) return false;
  const targetTotal = target.parsedTotalCents;
  return allOrders.some((o) =>
    o.orderId !== matchedInvoiceNumber &&
    o.parsedTotalCents === targetTotal &&
    daysBetween(o.date, txnDate) <= windowDays);
}

interface Args { entity: Entity; since: string; live: boolean; limit: number; csvPath: string | null; windowDays: number }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  };
  const entityArg = get('--entity');
  if (!entityArg) {
    throw new Error(
      'Usage: npx tsx scripts/receipt-capture/run-uline.ts --entity=FL|TN|TX [--since 2025-09-01] [--live] [--limit 5] [--csv path] [--window 3]',
    );
  }
  if (!ALL_ENTITIES.includes(entityArg as Entity)) throw new Error(`Unknown --entity ${entityArg} (expected FL, TN, or TX)`);

  const windowDays = Number(get('--window') ?? String(DEFAULT_WINDOW_DAYS)) || DEFAULT_WINDOW_DAYS;
  if (windowDays > WINDOW_CONFIRM_THRESHOLD) {
    console.warn(`[warn] --window=${windowDays} exceeds the ${WINDOW_CONFIRM_THRESHOLD}-day cap agreed for ULINE dry-runs — confirm with the team lead before trusting these matches.`);
  }

  return {
    entity: entityArg as Entity,
    since: get('--since') ?? '2025-09-01',
    live: argv.includes('--live'),
    limit: Number(get('--limit') ?? '5') || 5,
    csvPath: get('--csv'),
    windowDays,
  };
}

// ---- account identity guard ----
// The `--entity` flag is a LABEL ONLY (see uline-cdp.ts) — it does not select which ULINE account
// is used. Account identity comes from whichever storageState is signed in. This must be verified
// BEFORE any scraping happens; a mismatch is a hard stop, nothing else runs for that entity.
function expectedAccountName(entity: Entity): string {
  const env = process.env[`ULINE_ACCOUNT_${entity}`];
  if (env && env.trim()) return env.trim();
  const fallback = DEFAULT_ACCOUNT_NAME[entity];
  if (fallback) return fallback;
  throw new Error(
    `ULINE_ACCOUNT_ENV_MISSING: no ULINE_ACCOUNT_${entity} env var set and no observed default for ${entity}. ` +
    `Set ULINE_ACCOUNT_${entity} to the exact company-name label shown in the #CompanyName header on ULINE's ` +
    `MyOrderHistory page for the ${entity} account before running.`,
  );
}

async function assertAccountMatches(entity: Entity, page: Page): Promise<void> {
  const expected = expectedAccountName(entity);
  const actual = await getUlineAccountName(page);
  if (actual.trim().toUpperCase() !== expected.toUpperCase()) {
    throw new Error(
      `ULINE_ACCOUNT_MISMATCH: signed-in ULINE account is "${actual}", expected "${expected}" for entity ${entity} ` +
      `(env ULINE_ACCOUNT_${entity}). Hard stop — nothing else runs for ${entity}.`,
    );
  }
  console.log(`[${entity}] ULINE account verified: "${actual}"`);
}

// ---- CSV enrichment (Export tab -> MyOrderHistory.csv) ----
// The export has preamble rows before the real header; find it by content, never by line number.
function normalizeHeaderCell(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseUlineCsv(text: string): UlineCsvRow[] {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => {
    const cells = parseCsvLine(l).map(normalizeHeaderCell);
    return cells.includes('date') && cells.includes('order') && cells.includes('description');
  });
  if (headerIdx === -1) {
    throw new Error('ULINE CSV: could not find the Date/Order #/Category/Model #/Description header row — export shape may have changed.');
  }
  const header = parseCsvLine(lines[headerIdx]).map(normalizeHeaderCell);
  const col = (name: string): number => header.indexOf(name);
  const orderIdx = col('order');
  const categoryIdx = col('category');
  const modelIdx = col('model');
  const descIdx = col('description');
  if ([orderIdx, categoryIdx, modelIdx, descIdx].some((i) => i === -1)) {
    throw new Error(`ULINE CSV: expected Order #/Category/Model #/Description columns not found (got: ${header.join(', ')}).`);
  }

  const rows: UlineCsvRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = parseCsvLine(lines[i]);
    const orderNumber = (cells[orderIdx] ?? '').trim();
    if (!orderNumber) continue;
    rows.push({
      orderNumber,
      category: (cells[categoryIdx] ?? '').trim(),
      model: (cells[modelIdx] ?? '').trim(),
      description: (cells[descIdx] ?? '').trim(),
    });
  }
  return rows;
}

// ---- category side-cache ----
// ExtractedOrder (the shared walmart-enrich cache record) has no category field on its items — it
// was designed for TopRx, which has no CSV/category concept at all. Rather than widen that shared
// type for one vendor, categories captured via enrichCategories are persisted here, keyed by
// invoice number, as a parallel array aligned to the cached record's items by index (parseUlineInvoice
// is deterministic over a given PDF's text, so the alignment holds across separate runs, not just
// within one). Write-through on every successful parse, same resumability guarantee as the main cache.
type CategoryCache = Record<string, (string | null)[]>;

function loadCategoryCache(path: string): CategoryCache {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as CategoryCache;
}

function saveCategoryCache(path: string, data: CategoryCache): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function toVendorParsed(rec: ExtractedOrder, categories: (string | null)[] | null): VendorParsed {
  return {
    layout: null,
    source: null,
    order: rec.orderId,
    glHint: null,
    items: rec.items.map((i, idx) => ({ desc: i.desc, amountCents: i.amountCents, category: categories?.[idx] ?? null })),
    taxCents: rec.taxCents,
    shippingCents: rec.shippingCents,
    tipCents: rec.tipCents,
    parsedTotalCents: rec.parsedTotalCents,
  };
}

interface PlanRow {
  invoiceNumber: string;
  orderNumber: string;
  txnId: string;
  txnDate: string;
  amountCents: number;
  dateGapDays: number | null;
  reconciles: boolean | null;
  codedLines: number | null;
  suspenseLines: number | null;
  memo: string | null;
  receiptFilename: string | null;
  plannedActions: string;
  mode: 'live' | 'dry_run';
  notes: string;
}

function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function planRowLine(r: PlanRow): string {
  return [
    r.invoiceNumber, r.orderNumber, r.txnId, r.txnDate,
    (r.amountCents / 100).toFixed(2),
    r.dateGapDays === null ? '' : String(r.dateGapDays),
    r.reconciles === null ? '' : (r.reconciles ? 'Y' : 'N'),
    r.codedLines === null ? '' : String(r.codedLines),
    r.suspenseLines === null ? '' : String(r.suspenseLines),
    r.memo ?? '', r.receiptFilename ?? '', r.plannedActions, r.mode, r.notes,
  ].map(csv).join(',');
}

function skipRow(o: WalmartOrder, orderNumberByInvoice: Map<string, string>, notes: string): PlanRow {
  return {
    invoiceNumber: o.orderId,
    orderNumber: orderNumberByInvoice.get(o.orderId) ?? o.orderId,
    txnId: '', txnDate: '', amountCents: o.totalCents, dateGapDays: null, reconciles: null,
    codedLines: null, suspenseLines: null, memo: null, receiptFilename: null,
    plannedActions: 'skip', mode: 'dry_run', notes,
  };
}

function gapDistribution(gaps: number[]): string {
  if (gaps.length === 0) return 'n/a (0 matches)';
  const counts = new Map<number, number>();
  for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
  const hist = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([gap, n]) => `${gap}d:${n}`).join(' ');
  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return `min=${min} max=${max} avg=${avg.toFixed(1)} | ${hist}`;
}

async function extractEntity(
  entity: Entity,
  since: string,
  store: ReturnType<typeof loadStore>,
  csvRows: UlineCsvRow[] | null,
  categoryCache: CategoryCache,
  categoryCachePath: string,
): Promise<{ roster: UlineInvoice[]; fetched: number; parseFailures: number; pdfFailures: number }> {
  return withUlineContext(entity, async (page) => {
    await assertAccountMatches(entity, page);

    const roster = await scrapeUlineRoster(page);
    const inWindow = roster.filter((r) => r.date >= since);
    const missing = inWindow.filter((r) => !store.has(r.invoiceNumber));
    console.log(`[${entity}] roster: ${roster.length} invoice(s), ${inWindow.length} on/after ${since}, ${missing.length} to extract`);

    let fetched = 0;
    let parseFailures = 0;
    let pdfFailures = 0;
    if (!existsSync(PDF_DIR)) mkdirSync(PDF_DIR, { recursive: true });
    for (const inv of missing) {
      let pdf: Buffer;
      try {
        pdf = await fetchUlineInvoicePdf(page, inv);
      } catch (e) {
        console.error(`  [${entity}] ${inv.invoiceNumber}: PDF fetch failed — ${(e as Error).message}`);
        pdfFailures++;
        continue;
      }
      const parsedPdf = await pdfParse(pdf);
      let parsed = parseUlineInvoice(parsedPdf.text);
      if (!parsed) {
        console.error(`  [${entity}] ${inv.invoiceNumber}: invoice text did not parse — skipping`);
        parseFailures++;
        continue;
      }
      if (csvRows) {
        // Filter to THIS invoice's order before enriching — the CSV spans many orders, and
        // reusing another order's model/description rows for category matching (cross-order
        // model reuse) risks a wrong-category hit purely by coincidence of model number.
        const forOrder = csvRows.filter((r) => r.orderNumber === inv.orderNumber);
        parsed = enrichCategories(parsed, forOrder);
      }
      const pdfPath = `${PDF_DIR}/uline-${entity}-${inv.invoiceNumber}.pdf`;
      writeFileSync(pdfPath, pdf);
      store.put({
        orderId: inv.invoiceNumber, // cache is keyed by INVOICE number, not order number, per spec
        date: inv.date,
        totalCents: 0, // ULINE's grid/CSV carry no order-level total; parsedTotalCents (below) is authoritative
        items: parsed.items.map((i) => ({ desc: i.desc, amountCents: i.amountCents })),
        taxCents: parsed.taxCents,
        shippingCents: parsed.shippingCents,
        tipCents: parsed.tipCents,
        parsedTotalCents: parsed.parsedTotalCents,
        pdfPath,
        fetchedAt: new Date().toISOString(),
      });
      categoryCache[inv.invoiceNumber] = parsed.items.map((i) => i.category);
      saveCategoryCache(categoryCachePath, categoryCache);
      fetched++;
      console.log(`  [${entity}] invoice ${inv.invoiceNumber} order ${inv.orderNumber} ${inv.date} items=${parsed.items.length} parsed=$${(parsed.parsedTotalCents / 100).toFixed(2)}`);
    }
    return { roster, fetched, parseFailures, pdfFailures };
  });
}

async function runEntity(entity: Entity, args: Args, runId: string): Promise<void> {
  const cachePath = `${OUT}/uline-cache-${entity}.json`;
  const categoryCachePath = `${OUT}/uline-categories-${entity}.json`;
  const store = loadStore(cachePath);
  const categoryCache = loadCategoryCache(categoryCachePath);

  const csvRows = args.csvPath ? parseUlineCsv(readFileSync(args.csvPath, 'utf8')) : null;
  if (csvRows) console.log(`[${entity}] loaded ${csvRows.length} CSV row(s) from ${args.csvPath}`);

  const { roster, fetched, parseFailures, pdfFailures } = await extractEntity(entity, args.since, store, csvRows, categoryCache, categoryCachePath);
  const orderNumberByInvoice = new Map<string, string>(roster.map((inv) => [inv.invoiceNumber, inv.orderNumber]));

  const token = await rampToken(entity, args.live ? SCOPES_WRITE : SCOPES_READ);
  const gl = await buildGlIndex(entity, token);
  const worklist = await fetchWorklist(VENDOR, entity, token);

  // Single-pass match: unlike TopRx, ULINE's roster/CSV carry no order-level total at all, so
  // there is no second field to fall back to — parsedTotalCents is the only candidate.
  const cachedOrders: ExtractedOrder[] = store.all().filter((r) => r.date >= args.since && r.parsedTotalCents > 0);
  const orderList: WalmartOrder[] = cachedOrders.map((r) => ({ orderId: r.orderId, date: r.date, totalCents: r.parsedTotalCents }));
  const match = matchOrders(orderList, worklist, args.windowDays);

  const rows: PlanRow[] = [];
  for (const o of match.ambiguous) rows.push(skipRow(o, orderNumberByInvoice, 'ambiguous_match'));
  for (const o of match.unmatched) rows.push(skipRow(o, orderNumberByInvoice, 'no_ramp_match'));

  let reconciled = 0;
  let liveWrites = 0;
  let collisions = 0;
  const gaps: number[] = [];
  const fullCache = store.all();
  for (const m of match.confident) {
    const rec = store.get(m.order.orderId)!;
    const invoiceNumber = m.order.orderId;
    const orderNumber = orderNumberByInvoice.get(invoiceNumber) ?? invoiceNumber;

    if (hasSameTotalCompetitor(fullCache, invoiceNumber, m.txn.date, args.windowDays)) {
      collisions++;
      rows.push({
        invoiceNumber, orderNumber, txnId: m.txn.id, txnDate: m.txn.date,
        amountCents: m.txn.amountCents, dateGapDays: null, reconciles: null, codedLines: null, suspenseLines: null,
        memo: null, receiptFilename: null, plannedActions: 'skip', mode: 'dry_run', notes: 'same_total_collision',
      });
      // No audit row here even in --live, same reasoning as run-toprx.ts: a collision never
      // reaches the live branch below, so there is nothing for the audit trail to record.
      continue;
    }

    const gap = daysBetween(m.txn.date, m.order.date);
    gaps.push(gap);

    // Structurally always true here: matchOrders matched on exact equality of
    // rec.parsedTotalCents === m.txn.amountCents in the first place. Kept as an explicit gate
    // (mirroring run-toprx.ts's skip rules) as a defensive invariant check, not dead code removal.
    const reconciles = rec.parsedTotalCents === m.txn.amountCents;
    if (reconciles) reconciled++;

    const memo = `ULINE invoice #${invoiceNumber}, order #${orderNumber} (auto-captured)`;
    const receiptFilename = `ULINE-invoice-${invoiceNumber}.pdf`;
    const idempotencyKey = `rcpcap-uline-${m.txn.id}`;

    if (!reconciles) {
      rows.push({
        invoiceNumber, orderNumber, txnId: m.txn.id, txnDate: m.txn.date,
        amountCents: m.txn.amountCents, dateGapDays: gap, reconciles, codedLines: null, suspenseLines: null,
        memo, receiptFilename, plannedActions: 'skip', mode: 'dry_run', notes: 'no_reconcile: parsedTotalCents != txn.amountCents',
      });
      if (args.live) appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'skip', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: null, detail: 'no_reconcile' });
      continue;
    }
    if (!m.txn.userId) {
      rows.push({
        invoiceNumber, orderNumber, txnId: m.txn.id, txnDate: m.txn.date,
        amountCents: m.txn.amountCents, dateGapDays: gap, reconciles, codedLines: null, suspenseLines: null,
        memo, receiptFilename, plannedActions: 'skip', mode: 'dry_run', notes: 'missing_user_id',
      });
      if (args.live) appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'skip', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: null, detail: 'missing userId; receipts require it' });
      continue;
    }

    const built = buildVendorSplit(VENDOR, toVendorParsed(rec, categoryCache[invoiceNumber] ?? null), m.txn.amountCents, gl);
    const plannedActions = built ? 'attach_receipt;memo;split' : 'attach_receipt;memo';
    const notes = built ? '' : 'split_build_failed';

    const executeLive = args.live && liveWrites < args.limit;
    const mode: 'live' | 'dry_run' = executeLive ? 'live' : 'dry_run';

    if (executeLive) {
      const pdfBuf = readFileSync(rec.pdfPath);
      const att = await attachReceipt(entity, m.txn.id, pdfBuf, receiptFilename, token, m.txn.userId, idempotencyKey);
      appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'attach_receipt', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: att.status, detail: JSON.stringify(att.body).slice(0, 500) });

      const memoRes = await patchMemo(entity, m.txn.id, memo, token);
      appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'memo', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: memoRes.status, detail: JSON.stringify(memoRes.body).slice(0, 500) });

      if (built) {
        const splitRes = await patchSplit(entity, m.txn.id, built.lines.map((l) => ({ amount: l.amount, memo: l.memo, accounting_field_selections: l.accounting_field_selections })), token);
        appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'split', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: splitRes.status, detail: JSON.stringify(splitRes.body).slice(0, 500) });
      } else {
        appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'skip', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: null, detail: 'split_build_failed (receipt+memo still applied)' });
      }
      liveWrites++;
    }

    rows.push({
      invoiceNumber, orderNumber, txnId: m.txn.id, txnDate: m.txn.date,
      amountCents: m.txn.amountCents, dateGapDays: gap, reconciles, codedLines: built?.codedCount ?? null,
      suspenseLines: built?.suspenseCount ?? null, memo, receiptFilename,
      plannedActions, mode,
      notes: mode === 'dry_run' && args.live ? (notes ? `${notes}; over_limit` : 'over_limit') : notes,
    });
  }

  const planPath = `${OUT}/uline-plan-${entity}.csv`;
  const header = 'invoice_number,order_number,txn_id,txn_date,amount,date_gap_days,reconciles,coded_lines,suspense_lines,memo,receipt_filename,planned_actions,mode,notes';
  writeFileSync(planPath, [header, ...rows.map(planRowLine)].join('\n') + '\n');

  const matched = match.confident.length - collisions;
  console.log(
    `[${entity}] roster=${roster.length} extracted=+${fetched} parseFailures=${parseFailures} pdfFailures=${pdfFailures} cached=${store.all().length} | ` +
    `matched=${matched} ambiguous=${match.ambiguous.length + collisions} (same_total_collision=${collisions}) unmatched=${match.unmatched.length} | ` +
    `reconciled=${reconciled}/${matched} | window=${args.windowDays}d date-gap(days): ${gapDistribution(gaps)} | ` +
    `${args.live ? `live writes=${liveWrites} (limit ${args.limit})` : 'dry-run (no writes)'}`,
  );
  console.log(`[${entity}] wrote ${planPath} (${rows.length} rows), cache ${cachePath}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const runId = `uline-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(
    `run ${runId} | entity=${args.entity} | since=${args.since} | window=${args.windowDays}d | ` +
    `mode=${args.live ? `LIVE (limit ${args.limit})` : 'DRY-RUN'}${args.csvPath ? ` | csv=${args.csvPath}` : ''}`,
  );
  try {
    await runEntity(args.entity, args, runId);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (msg.includes('ULINE_SIGNIN_REQUIRED') || msg.startsWith('No ULINE session for')) {
      console.error(`\n[${args.entity}] ULINE sign-in required:\n${msg}\n`);
      process.exit(2);
    }
    if (msg.startsWith('ULINE_ACCOUNT_MISMATCH') || msg.startsWith('ULINE_ACCOUNT_ENV_MISSING')) {
      console.error(`\n[${args.entity}] ${msg}\n`);
      process.exit(3);
    }
    throw e;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
