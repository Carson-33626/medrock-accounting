// ULINE orchestrator: EXTRACT (roster + invoice PDFs -> resumable cache) then MATCH+PLAN against
// un-receipted Ramp ULINE card charges, then (only with --live) attach receipt + memo + split for
// matched+reconciled txns, capped at --limit. Dry-run by default: zero Ramp writes, only reads.
// Mirrors run-toprx.ts's extract/match/plan/write shape; the differences below are dictated by
// ULINE's actual surface (session storageState instead of CDP-attach, per-entity account identity
// that must be verified rather than assumed, no order-level total anywhere except the parsed PDF).
//
// JOINT MODE (--entity=FL,TN): FL and TN are one ULINE account (different logins, one shared
// invoice roster — Carson confirmed 2026-07-29). Extraction runs ONCE, using the FIRST listed
// entity's session (one login sees the whole roster), against a shared cache
// (out/uline-cache-FLTN.json). Both entities' Ramp worklists are pooled and matched jointly
// against the union — matchOrders' per-order "first unique candidate wins, else ambiguous" rule
// applies across the pooled txn list, which structurally guarantees an invoice is claimed by at
// most one txn (and therefore at most one entity) per run. Attach/memo/split for a matched txn
// always run under THAT txn's own entity token + userId, never the extraction entity's.
// TX is a separate account and only ever runs solo.
//
// The consumed-invoice registry (uline-consumed.ts) is a second, cross-run guard on top of the
// in-run union match: it remembers every invoice that has ever had a receipt attached (by either
// entity, in either joint or solo mode) so a later run — solo or joint — can never double-claim
// it even after the worklist/cache state has moved on.
//   npx tsx scripts/receipt-capture/run-uline.ts --entity=FL [--since 2025-09-01] [--live] [--limit 5] [--csv path/to/MyOrderHistory.csv] [--window 3]
//   npx tsx scripts/receipt-capture/run-uline.ts --entity=FL,TN [--since ...] [--live] [--limit 5] [--csv path] [--window 3]
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
import type { GlIndex } from '../amazon-enrich/gl-resolve';
import { rampToken } from '../ramp-split-push/ramp-client';
import { appendAudit } from './audit';
import { loadConsumedStore } from './uline-consumed';
import { parseNumericFlag, resolveSince } from './cli-args';
import type { Entity, RampTxn } from '../ramp-split-push/types';
import { ALL_ENTITIES } from '../ramp-split-push/types';

const OUT = 'scripts/receipt-capture/out';
const PDF_DIR = `${OUT}/pdf`;
const AUDIT_PATH = `${OUT}/receipt-capture-audit.csv`;
const CONSUMED_PATH = `${OUT}/uline-consumed.json`;
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
// simpler than the TopRx version: always compare on parsedTotalCents against the FULL cache
// (joint mode shares one cache across FL+TN, so this comparison already covers both entities).
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

interface Args { entities: Entity[]; since: string; live: boolean; limit: number; csvPath: string | null; windowDays: number }

function parseEntities(raw: string): Entity[] {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('--entity must name at least one of FL, TN, or TX');
  const entities: Entity[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (!ALL_ENTITIES.includes(p as Entity)) throw new Error(`Unknown --entity ${p} (expected FL, TN, or TX)`);
    if (!seen.has(p)) { seen.add(p); entities.push(p as Entity); }
  }
  return entities;
}

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
      'Usage: npx tsx scripts/receipt-capture/run-uline.ts --entity=FL|TN|TX|FL,TN [--since 2025-09-01] [--live] [--limit 5] [--csv path] [--window 3]',
    );
  }
  const entities = parseEntities(entityArg);

  const windowDays = parseNumericFlag('--window', get('--window'), DEFAULT_WINDOW_DAYS, 'reject');
  if (windowDays > WINDOW_CONFIRM_THRESHOLD) {
    console.warn(`[warn] --window=${windowDays} exceeds the ${WINDOW_CONFIRM_THRESHOLD}-day cap agreed for ULINE dry-runs — confirm with the team lead before trusting these matches.`);
  }

  return {
    entities,
    since: resolveSince(get('--since')),
    live: argv.includes('--live'),
    limit: parseNumericFlag('--limit', get('--limit'), 5, 'clamp'),
    csvPath: get('--csv'),
    windowDays,
  };
}

// ---- account identity guard ----
// The `--entity` flag is a LABEL ONLY (see uline-cdp.ts) — it does not select which ULINE account
// is used. Account identity comes from whichever storageState is signed in. This must be verified
// BEFORE any scraping happens; a mismatch is a hard stop, nothing else runs for that entity. In
// joint mode this only ever runs once, against the FIRST listed entity (the session actually used).
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
  entity: string;
  orderNumber: string;
  txnId: string;
  txnDate: string;
  amountCents: number;
  cardHolder: string | null;
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
    r.invoiceNumber, r.entity, r.orderNumber, r.txnId, r.txnDate,
    (r.amountCents / 100).toFixed(2),
    r.dateGapDays === null ? '' : String(r.dateGapDays),
    r.reconciles === null ? '' : (r.reconciles ? 'Y' : 'N'),
    r.codedLines === null ? '' : String(r.codedLines),
    r.suspenseLines === null ? '' : String(r.suspenseLines),
    r.memo ?? '', r.receiptFilename ?? '', r.plannedActions, r.mode, r.notes, r.cardHolder ?? '',
  ].map(csv).join(',');
}

// Used for roster entries that never matched any pooled txn (ambiguous/no_ramp_match) — these are
// order-level, not txn-level, so in joint mode they aren't tied to one entity; `entityLabel` is
// the full pooled entity list (e.g. "FL,TN"), same value solo mode would produce for its one entity.
function skipRow(o: WalmartOrder, orderNumberByInvoice: Map<string, string>, notes: string, entityLabel: string): PlanRow {
  return {
    invoiceNumber: o.orderId,
    entity: entityLabel,
    orderNumber: orderNumberByInvoice.get(o.orderId) ?? o.orderId,
    txnId: '', txnDate: '', amountCents: o.totalCents, cardHolder: null, dateGapDays: null, reconciles: null,
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

// ---- joint-cache helpers ----
// Cache key is order-independent (sorted) so `--entity=FL,TN` and `--entity=TN,FL` share one file.
function cacheKey(entities: Entity[]): string {
  return entities.length === 1 ? entities[0] : [...entities].sort().join('');
}

// One-time seed for a brand-new joint cache: the FL-only cache already holds the same shared
// roster (Carson confirmed the TN dry-run roster was invoice-identical to FL's), so the joint
// cache starts from it instead of re-fetching everything. The FL-only cache file is never
// deleted or mutated — this is a copy, and if the joint cache already exists this is a no-op.
function seedJointCacheIfNeeded(entities: Entity[], jointCachePath: string, jointCategoryCachePath: string): void {
  if (entities.length <= 1) return;
  const flCachePath = `${OUT}/uline-cache-FL.json`;
  const flCategoryCachePath = `${OUT}/uline-categories-FL.json`;
  if (!existsSync(jointCachePath) && existsSync(flCachePath)) {
    writeFileSync(jointCachePath, readFileSync(flCachePath, 'utf8'));
    console.log(`[joint] seeded ${jointCachePath} from ${flCachePath} (source preserved)`);
  }
  if (!existsSync(jointCategoryCachePath) && existsSync(flCategoryCachePath)) {
    writeFileSync(jointCategoryCachePath, readFileSync(flCategoryCachePath, 'utf8'));
    console.log(`[joint] seeded ${jointCategoryCachePath} from ${flCategoryCachePath} (source preserved)`);
  }
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

    // The grid is endless-scroll, so the roster only reaches back as far as we scroll — `since`
    // has to drive the scrape itself, not just filter what it happened to return.
    const roster = await scrapeUlineRoster(page, { since });
    const undated = roster.filter((r) => r.date === '');
    const inWindow = roster.filter((r) => r.date >= since);
    const missing = inWindow.filter((r) => !store.has(r.invoiceNumber));
    console.log(`[${entity}] roster: ${roster.length} invoice(s), ${inWindow.length} on/after ${since}, ${missing.length} to extract`);
    // A dateless invoice is dropped by the window filter above. That used to happen to 37% of the
    // roster silently (the Date column is blank on every row after the first of its date group);
    // if it ever recurs, it must be loud.
    if (undated.length > 0) {
      console.log(`[${entity}] [warn] ${undated.length} roster invoice(s) have no parsed date and were skipped: ${undated.slice(0, 5).map((r) => r.invoiceNumber).join(', ')}`);
    }

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
      // Wrong-document guard: a timed-out fetch attempt can keep driving the shared ULINE page in
      // the background, and its late-arriving download can land under the NEXT invoice's loop
      // iteration/cache key. parsed.order (the invoice number printed IN the PDF) is the ground
      // truth for which invoice this download actually is — if it disagrees with the invoice we
      // asked for, this is a misattributed fetch, not a parse failure of THIS invoice, so it must
      // not be cached under inv.invoiceNumber. (TopRx does not get this same check: multi-invoice
      // orders there make strict order<->invoice equality a false positive.)
      if (parsed.order !== null && parsed.order !== inv.invoiceNumber) {
        console.error(`  [${entity}] ${inv.invoiceNumber}: invoice_number_mismatch expected=${inv.invoiceNumber} got=${parsed.order}`);
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

async function runUline(entities: Entity[], args: Args, runId: string): Promise<void> {
  const joint = entities.length > 1;
  const key = cacheKey(entities);
  const cachePath = `${OUT}/uline-cache-${key}.json`;
  const categoryCachePath = `${OUT}/uline-categories-${key}.json`;
  seedJointCacheIfNeeded(entities, cachePath, categoryCachePath);

  const store = loadStore(cachePath);
  const categoryCache = loadCategoryCache(categoryCachePath);
  const consumed = loadConsumedStore(CONSUMED_PATH);

  // The consumed registry is the only guard against a joint/solo run double-claiming an invoice
  // across separate invocations (see file header). If it failed to parse, `consumed.has()` below
  // would silently behave as if NOTHING has ever been claimed — exactly the double-claim scenario
  // this registry exists to prevent. A --live run must hard-stop rather than write against that
  // false-empty state; --dry-run can proceed (nothing gets written) but only with a loud warning,
  // since its plan CSV's `consumed` skip notes are not trustworthy while the registry is down.
  if (consumed.corrupt) {
    if (args.live) {
      throw new Error(
        `ULINE_CONSUMED_REGISTRY_CORRUPT: ${CONSUMED_PATH} failed to parse — hard stop before any ` +
        `live write to avoid double-claiming an invoice already receipted by a prior run. Inspect/` +
        `restore the file (or delete it to start a fresh, but no-longer-protective, registry) before retrying --live.`,
      );
    }
    console.warn(
      `[WARN] ${CONSUMED_PATH} failed to parse — consumed-invoice registry is running EMPTY this ` +
      `dry-run. Any 'consumed' skip notes in the plan CSV are not trustworthy; do not treat a clean ` +
      `dry-run as proof no invoice here was already claimed. Repair/restore the registry before going --live.`,
    );
  }

  const csvRows = args.csvPath ? parseUlineCsv(readFileSync(args.csvPath, 'utf8')) : null;
  if (csvRows) console.log(`[${entities.join(',')}] loaded ${csvRows.length} CSV row(s) from ${args.csvPath}`);

  // Extraction runs ONCE, against the FIRST listed entity's session — that login sees the whole
  // shared roster in joint mode; in solo mode this is just the one entity.
  const extractEntityName = entities[0];
  const { roster, fetched, parseFailures, pdfFailures } = await extractEntity(extractEntityName, args.since, store, csvRows, categoryCache, categoryCachePath);
  const orderNumberByInvoice = new Map<string, string>(roster.map((inv) => [inv.invoiceNumber, inv.orderNumber]));

  // Per-entity tokens/GL indices/worklists, pooled for joint matching. Each entity needs its own
  // write-scope token in live mode since a matched txn's attach/memo/split runs under that txn's
  // own entity, never the extraction entity's.
  const tokenByEntity = new Map<Entity, string>();
  const glByEntity = new Map<Entity, GlIndex>();
  const worklistByEntity = new Map<Entity, RampTxn[]>();
  for (const e of entities) {
    const token = await rampToken(e, args.live ? SCOPES_WRITE : SCOPES_READ);
    tokenByEntity.set(e, token);
    glByEntity.set(e, await buildGlIndex(e, token));
    worklistByEntity.set(e, await fetchWorklist(VENDOR, e, token));
  }
  const pooledWorklist: RampTxn[] = entities.flatMap((e) => worklistByEntity.get(e)!);

  // Single-pass match: unlike TopRx, ULINE's roster/CSV carry no order-level total at all, so
  // there is no second field to fall back to — parsedTotalCents is the only candidate. matchOrders
  // is entity-agnostic (it only reads RampTxn.id/amountCents/date); pooling both entities' txns
  // here IS the joint match — an invoice can only ever land a single confident candidate across
  // the whole pooled list, so it is claimed by at most one entity's txn.
  const cachedOrders: ExtractedOrder[] = store.all().filter((r) => r.date >= args.since && r.parsedTotalCents > 0);
  const orderList: WalmartOrder[] = cachedOrders.map((r) => ({ orderId: r.orderId, date: r.date, totalCents: r.parsedTotalCents }));
  const match = matchOrders(orderList, pooledWorklist, args.windowDays);

  const rows: PlanRow[] = [];
  const poolLabel = entities.join(',');
  for (const o of match.ambiguous) rows.push(skipRow(o, orderNumberByInvoice, 'ambiguous_match', poolLabel));
  for (const o of match.unmatched) rows.push(skipRow(o, orderNumberByInvoice, 'no_ramp_match', poolLabel));

  let reconciled = 0;
  let liveWrites = 0;
  let collisions = 0;
  let consumedSkips = 0;
  const gaps: number[] = [];
  const fullCache = store.all();
  const matchedByEntity = new Map<Entity, number>(entities.map((e) => [e, 0]));
  for (const m of match.confident) {
    const rec = store.get(m.order.orderId)!;
    const invoiceNumber = m.order.orderId;
    const orderNumber = orderNumberByInvoice.get(invoiceNumber) ?? invoiceNumber;
    const entity = m.txn.entity;
    const priorMemo = m.txn.memo;
    const priorLineItems = m.txn.priorLineItems == null ? '' : JSON.stringify(m.txn.priorLineItems);

    // Consumed-invoice registry: a cross-run guard on top of the in-run union match. Checked in
    // BOTH joint and solo modes, before any collision/reconcile logic, so an invoice a prior run
    // (joint or solo) already attached a receipt for is never re-planned here.
    if (consumed.has(invoiceNumber)) {
      consumedSkips++;
      rows.push({
        invoiceNumber, entity, orderNumber, txnId: m.txn.id, txnDate: m.txn.date,
        amountCents: m.txn.amountCents, cardHolder: m.txn.cardHolder, dateGapDays: null, reconciles: null, codedLines: null, suspenseLines: null,
        memo: null, receiptFilename: null, plannedActions: 'skip', mode: 'dry_run', notes: 'consumed',
      });
      if (args.live) appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'skip', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: null, detail: 'consumed (already recorded in uline-consumed.json)', priorMemo, priorLineItems });
      continue;
    }

    if (hasSameTotalCompetitor(fullCache, invoiceNumber, m.txn.date, args.windowDays)) {
      collisions++;
      rows.push({
        invoiceNumber, entity, orderNumber, txnId: m.txn.id, txnDate: m.txn.date,
        amountCents: m.txn.amountCents, cardHolder: m.txn.cardHolder, dateGapDays: null, reconciles: null, codedLines: null, suspenseLines: null,
        memo: null, receiptFilename: null, plannedActions: 'skip', mode: 'dry_run', notes: 'same_total_collision',
      });
      // No audit row here even in --live, same reasoning as run-toprx.ts: a collision never
      // reaches the live branch below, so there is nothing for the audit trail to record.
      continue;
    }

    matchedByEntity.set(entity, (matchedByEntity.get(entity) ?? 0) + 1);
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
        invoiceNumber, entity, orderNumber, txnId: m.txn.id, txnDate: m.txn.date,
        amountCents: m.txn.amountCents, cardHolder: m.txn.cardHolder, dateGapDays: gap, reconciles, codedLines: null, suspenseLines: null,
        memo, receiptFilename, plannedActions: 'skip', mode: 'dry_run', notes: 'no_reconcile: parsedTotalCents != txn.amountCents',
      });
      if (args.live) appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'skip', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: null, detail: 'no_reconcile', priorMemo, priorLineItems });
      continue;
    }
    if (!m.txn.userId) {
      rows.push({
        invoiceNumber, entity, orderNumber, txnId: m.txn.id, txnDate: m.txn.date,
        amountCents: m.txn.amountCents, cardHolder: m.txn.cardHolder, dateGapDays: gap, reconciles, codedLines: null, suspenseLines: null,
        memo, receiptFilename, plannedActions: 'skip', mode: 'dry_run', notes: 'missing_user_id',
      });
      if (args.live) appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'skip', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: null, detail: 'missing userId; receipts require it', priorMemo, priorLineItems });
      continue;
    }

    const gl = glByEntity.get(entity)!;
    const token = tokenByEntity.get(entity)!;
    const built = buildVendorSplit(VENDOR, toVendorParsed(rec, categoryCache[invoiceNumber] ?? null), m.txn.amountCents, gl);
    const plannedActions = built ? 'attach_receipt;memo;split' : 'attach_receipt;memo';
    const notes = built ? '' : 'split_build_failed';

    const executeLive = args.live && liveWrites < args.limit;
    const mode: 'live' | 'dry_run' = executeLive ? 'live' : 'dry_run';

    if (executeLive) {
      const pdfBuf = readFileSync(rec.pdfPath);
      const att = await attachReceipt(entity, m.txn.id, pdfBuf, receiptFilename, token, m.txn.userId, idempotencyKey);
      const attachOk = att.status >= 200 && att.status < 300;
      appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: attachOk ? 'attach_receipt' : 'error', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: att.status, detail: JSON.stringify(att.body).slice(0, 500), priorMemo, priorLineItems });

      if (attachOk) {
        // Recorded immediately after the 2xx attach — before memo/split — so even if a later step
        // in this same run fails, the registry already reflects that this invoice has a receipt.
        consumed.record(invoiceNumber, m.txn.id, entity);

        const memoRes = await patchMemo(entity, m.txn.id, memo, token);
        appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'memo', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: memoRes.status, detail: JSON.stringify(memoRes.body).slice(0, 500), priorMemo, priorLineItems });

        if (built) {
          const splitRes = await patchSplit(entity, m.txn.id, built.lines.map((l) => ({ amount: l.amount, memo: l.memo, accounting_field_selections: l.accounting_field_selections })), token);
          appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'split', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: splitRes.status, detail: JSON.stringify(splitRes.body).slice(0, 500), priorMemo, priorLineItems });
        } else {
          appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: m.txn.id, action: 'skip', invoiceKey: invoiceNumber, amountCents: m.txn.amountCents, status: null, detail: 'split_build_failed (receipt+memo still applied)', priorMemo, priorLineItems });
        }
      }
      // A failed attach short-circuits memo/split for this txn — there's nothing receipted to hang
      // a memo/split off of. Still counts against liveWrites (comment, not a behavior change from
      // before): a failed attach still consumed this run's write attempt, so the cap stays
      // conservative rather than letting a string of failures loop past --limit within one invocation.
      liveWrites++;
    }

    rows.push({
      invoiceNumber, entity, orderNumber, txnId: m.txn.id, txnDate: m.txn.date,
      amountCents: m.txn.amountCents, cardHolder: m.txn.cardHolder, dateGapDays: gap, reconciles, codedLines: built?.codedCount ?? null,
      suspenseLines: built?.suspenseCount ?? null, memo, receiptFilename,
      plannedActions, mode,
      notes: mode === 'dry_run' && args.live ? (notes ? `${notes}; over_limit` : 'over_limit') : notes,
    });
  }

  const matchedTxnIds = new Set(match.confident.map((m) => m.txn.id));
  const noInvoiceMatchTxns = pooledWorklist.filter((t) => !matchedTxnIds.has(t.id));
  for (const t of noInvoiceMatchTxns) {
    rows.push({
      invoiceNumber: '', entity: t.entity, orderNumber: '', txnId: t.id, txnDate: t.date, amountCents: t.amountCents,
      cardHolder: t.cardHolder, dateGapDays: null, reconciles: null, codedLines: null, suspenseLines: null,
      memo: null, receiptFilename: null, plannedActions: 'skip', mode: 'dry_run', notes: 'no_invoice_match',
    });
  }

  const planPath = `${OUT}/uline-plan-${key}.csv`;
  const header = 'invoice_number,entity,order_number,txn_id,txn_date,amount,date_gap_days,reconciles,coded_lines,suspense_lines,memo,receipt_filename,planned_actions,mode,notes,cardholder';
  writeFileSync(planPath, [header, ...rows.map(planRowLine)].join('\n') + '\n');

  const matched = match.confident.length - collisions - consumedSkips;
  const perEntitySummary = entities.map((e) => `${e}=${matchedByEntity.get(e) ?? 0}`).join(' ');
  console.log(
    `[${poolLabel}]${joint ? ' (joint)' : ''} roster=${roster.length} extracted=+${fetched} parseFailures=${parseFailures} pdfFailures=${pdfFailures} cached=${store.all().length} | ` +
    `matched=${matched} (by entity: ${perEntitySummary}) ambiguous=${match.ambiguous.length + collisions} (same_total_collision=${collisions}) unmatched=${match.unmatched.length} ` +
    `consumed_skips=${consumedSkips} noInvoiceMatch=${noInvoiceMatchTxns.length} | ` +
    `reconciled=${reconciled}/${matched} | window=${args.windowDays}d date-gap(days): ${gapDistribution(gaps)} | ` +
    `${args.live ? `live writes=${liveWrites} (limit ${args.limit})` : 'dry-run (no writes)'}`,
  );
  console.log(`[${poolLabel}] wrote ${planPath} (${rows.length} rows), cache ${cachePath}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const runId = `uline-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(
    `run ${runId} | entity=${args.entities.join(',')} | since=${args.since} | window=${args.windowDays}d | ` +
    `mode=${args.live ? `LIVE (limit ${args.limit})` : 'DRY-RUN'}${args.csvPath ? ` | csv=${args.csvPath}` : ''}`,
  );
  try {
    await runUline(args.entities, args, runId);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (msg.includes('ULINE_SIGNIN_REQUIRED') || msg.startsWith('No ULINE session for')) {
      console.error(`\n[${args.entities.join(',')}] ULINE sign-in required:\n${msg}\n`);
      process.exit(2);
    }
    if (msg.startsWith('ULINE_ACCOUNT_MISMATCH') || msg.startsWith('ULINE_ACCOUNT_ENV_MISSING')) {
      console.error(`\n[${args.entities.join(',')}] ${msg}\n`);
      process.exit(3);
    }
    if (msg.startsWith('ULINE_CONSUMED_REGISTRY_CORRUPT')) {
      console.error(`\n[${args.entities.join(',')}] ${msg}\n`);
      process.exit(4);
    }
    throw e;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
