// EXTRACT runner for Sam's Club (CDP method) — the Sam's counterpart to run-cdp.ts. Attaches to the
// user's real Chrome, pages the purchase-history roster, fetches each uncached order's detail, and writes
// through to the SAMS extraction cache. Extract-only: no Ramp calls, no writes outside the local cache.
// Resumable (write-through) and idempotent (skips already-cached orders).
//   npx tsx scripts/receipt-enrichment/engines/walmart-enrich/run-cdp-sams.ts [--since 2026-01-01] [--pages 100] [--limit N]
//                                                 [--min-delay 1800] [--max-delay 4500] [--long-every 12]
//
// Differs from Walmart in exactly the two ways the site does (spec §5a): the roster is delivered by the
// PurchaseHistoryV2 GraphQL call rather than server-rendered, and it carries order IDs only — no date or
// total — so every order needs a detail fetch before it can be filtered by date.
//
// PACING: Sam's flagged this scraper as a bot on 2026-07-30 when it ran fixed 400/600ms gaps. Every
// navigation now waits a randomised interval with periodic longer breaks (human-pacing.ts), the run
// ABORTS the moment a challenge page appears rather than hammering through it, and a run of consecutive
// detail failures trips a breaker — a silent block otherwise burns the whole roster and looks like
// "missing orders" instead of "we got blocked".
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import type { Browser, Page, Response } from '@playwright/test';
import { loadStore } from './extraction-store';
import { parseSamsOrder, parseSamsRoster, type RawSamsOrder, type RawHistory } from './sams-order';
import { Pacer, looksBlocked, DEFAULTS } from './human-pacing';
import { SAMS } from './retailer-profile';

const CDP_URL = process.env.WM_CDP_URL ?? 'http://127.0.0.1:9222';
const ORDERS_URL = 'https://www.samsclub.com/orders';
const ROSTER_CALL = /\/graphql\/PurchaseHistoryV2\//i;
const DETAIL_CALL = /\/graphql\/getOrder\//i;

function arg(flag: string, def: string): string {
  const eq = process.argv.find((x) => x.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1) || def;
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function samsPage(browser: Browser): Promise<Page> {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('Attached Chrome has no browser context.');
  return ctx.pages().find((p) => /samsclub\.com/i.test(p.url())) ?? (await ctx.newPage());
}

class BlockedError extends Error {}

// Read the page and stop the run if Sam's is challenging us. Solving the challenge is a HUMAN action in
// the real browser — never automate it. Aborting immediately also stops us digging the hole deeper.
async function assertNotBlocked(page: Page, where: string): Promise<void> {
  const text = await page.evaluate(`(document.body?.innerText || '').slice(0, 3000)`).catch(() => '') as string;
  if (looksBlocked(text, page.url())) {
    throw new BlockedError(
      `Sam's Club is showing a bot challenge at ${where} (${page.url()}).\n` +
      `  Clear it BY HAND in the Chrome window (it is the same browser), confirm you can load ` +
      `https://www.samsclub.com/orders normally, then re-run — the cache is write-through, so it resumes ` +
      `where it stopped. Consider a larger --min-delay/--max-delay if this keeps happening.`,
    );
  }
}

// Page the roster by REPLAYING the PurchaseHistoryV2 call the page itself makes, rather than clicking the
// "Next page" chevron. Two reasons, both learned on 2026-07-30:
//  - Clicking is fragile. The card list re-renders after each page, so the chevron momentarily leaves the
//    DOM; a loop that re-checks it straight away reads "no next button" and stops early. It reported
//    "end of history after 3 pages" while the button was plainly still on screen.
//  - The default view is DATE-LIMITED. It reached back only ~8 weeks, but Ramp has Sam's charges to
//    January. The roster call accepts `filterIds`, and the response advertises "By date" options
//    (`year-0` = 2026, `year-1` = 2025 …), so the full year needs that filter applied.
// The persisted-query hash and headers are captured from the page's own first request, so a Sam's deploy
// that rotates the hash is picked up automatically instead of hard-coded here.
async function scrapeRoster(page: Page, maxPages: number, pacer: Pacer, yearFilter: string): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const take = (body: RawHistory, label: string): { added: number; cursor: string | null } => {
    const { orderIds, nextCursor } = parseSamsRoster(body);
    let added = 0;
    for (const id of orderIds) if (!seen.has(id)) { seen.add(id); ids.push(id); added++; }
    console.log(`  roster ${label}: ${orderIds.length} order(s), +${added} new${nextCursor ? '' : ' (no further cursor)'}`);
    return { added, cursor: nextCursor };
  };

  const first: Promise<Response | null> = page.waitForResponse((r) => ROSTER_CALL.test(r.url()), { timeout: 30000 }).catch(() => null);
  await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const firstResp = await first;
  if (!firstResp) {
    await assertNotBlocked(page, 'the order list');
    throw new Error('No PurchaseHistoryV2 response on /orders — signed out, or the page shape changed.');
  }

  // Learn the endpoint, its variables shape, and the headers the app sends.
  const templateUrl = new URL(firstResp.url());
  const baseVars = JSON.parse(templateUrl.searchParams.get('variables') ?? '{"input":{}}') as { input: Record<string, unknown> };
  const headers = { ...firstResp.request().headers() };
  delete headers['content-length'];
  delete headers[':method']; delete headers[':path']; delete headers[':scheme']; delete headers[':authority'];

  const requestPage = async (cursor: string, filterIds: string[]): Promise<RawHistory> => {
    const url = new URL(templateUrl.toString());
    url.searchParams.set('variables', JSON.stringify({ ...baseVars, input: { ...baseVars.input, cursor, filterIds } }));
    const res = await page.request.get(url.toString(), { headers, timeout: 30000 });
    if (!res.ok()) throw new Error(`roster request HTTP ${res.status()}`);
    return await res.json() as RawHistory;
  };

  const filterIds = yearFilter === 'none' ? [] : [yearFilter];
  console.log(`  roster filter: ${filterIds.length ? filterIds.join(',') : '(site default — date-limited)'}`);

  // Page 1 already arrived unfiltered; if a filter is in play, request page 1 again through it.
  let cursor: string | null;
  if (filterIds.length) {
    await pacer.wait();
    cursor = take(await requestPage('', filterIds), 'page 1').cursor;
  } else {
    cursor = take(JSON.parse(await firstResp.text()) as RawHistory, 'page 1').cursor;
  }

  for (let p = 2; p <= maxPages && cursor; p++) {
    const w = await pacer.wait();
    let body: RawHistory;
    try {
      body = await requestPage(cursor, filterIds);
    } catch (e) {
      await assertNotBlocked(page, `roster page ${p}`);
      console.log(`  roster page ${p} failed (${(e as Error).message}) — stopping`);
      break;
    }
    const r = take(body, `page ${p}${w.long ? ' (after long pause)' : ''}`);
    if (r.added === 0) { console.log(`  page ${p} added nothing new — stopping (looped/duplicate)`); break; }
    cursor = r.cursor;
  }
  if (!cursor) console.log(`  reached the end of this filter's history`);
  return ids;
}

// Navigating to /orders/<id> fires getOrder; capture it rather than re-deriving the hashed URL.
export type OrderFetcher = (orderId: string) => Promise<RawSamsOrder | null>;

// Learn the getOrder endpoint from ONE real navigation, then replay it for every other order.
//
// Navigating per order was both slow and unreliable: the response body lives in the browser's network
// buffer, and the next navigation evicts it, so reading it afterwards died with
// "Network.getResponseBody: No resource with given identifier found". Replaying also means one HTTP call
// per order instead of a full page render, which is gentler on a site that has already flagged us.
// The body of the seed navigation is read INSIDE the response handler, before anything can evict it.
async function makeOrderFetcher(page: Page, seedOrderId: string): Promise<{ fetch: OrderFetcher; seed: RawSamsOrder | null }> {
  let seedBody: string | null = null;
  let templateUrl: URL | null = null;
  let headers: Record<string, string> = {};

  const onResp = async (r: Response): Promise<void> => {
    if (!DETAIL_CALL.test(r.url()) || seedBody !== null) return;
    templateUrl = new URL(r.url());
    headers = { ...r.request().headers() };
    delete headers['content-length'];
    for (const k of [':method', ':path', ':scheme', ':authority']) delete headers[k];
    try { seedBody = await r.text(); } catch { seedBody = null; }
  };
  page.on('response', onResp);
  try {
    await page.goto(`${ORDERS_URL}/${seedOrderId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
  } finally {
    page.off('response', onResp);
  }

  if (!templateUrl) {
    await assertNotBlocked(page, `order ${seedOrderId}`);
    throw new Error(`No getOrder call seen for ${seedOrderId} — the detail page shape may have changed.`);
  }

  const orderOf = (raw: string | null): RawSamsOrder | null => {
    if (!raw) return null;
    try { return (JSON.parse(raw) as { data?: { order?: RawSamsOrder } })?.data?.order ?? null; } catch { return null; }
  };
  const base = templateUrl as URL;
  const baseVars = JSON.parse(base.searchParams.get('variables') ?? '{}') as Record<string, unknown>;

  const fetch: OrderFetcher = async (orderId) => {
    const url = new URL(base.toString());
    url.searchParams.set('variables', JSON.stringify({ ...baseVars, orderId }));
    const res = await page.request.get(url.toString(), { headers, timeout: 30000 });
    if (!res.ok()) throw new Error(`getOrder HTTP ${res.status()}`);
    return orderOf(await res.text());
  };

  return { fetch, seed: orderOf(seedBody) };
}

async function main(): Promise<void> {
  const since = arg('--since', '2026-01-01');
  const maxPages = Number(arg('--pages', '100')) || 100;
  const limit = Number(arg('--limit', '0')) || 0;
  // Default to NO filter — the same unfiltered list the site shows. The earlier short run stopped at
  // ~8 weeks because the paging loop quit early, not because the history was filtered. `year-0` is the
  // current year, `year-1` the one before (per the filterGroups the roster advertises) if a narrower
  // pass is ever wanted.
  const yearFilter = arg('--year', 'none');
  const pacer = new Pacer({
    minMs: Number(arg('--min-delay', String(DEFAULTS.minMs))) || DEFAULTS.minMs,
    maxMs: Number(arg('--max-delay', String(DEFAULTS.maxMs))) || DEFAULTS.maxMs,
    longEvery: Number(arg('--long-every', String(DEFAULTS.longEvery))),
  });
  // Consecutive detail failures almost always mean a soft block rather than N odd orders; stopping keeps
  // a blocked run from silently producing a half-empty cache that reads like "these orders don't exist".
  const maxConsecutiveFailures = 3;
  // The roster is newest-first but carries no dates, so age is only known AFTER fetching an order. Once a
  // few in a row land before --since, everything remaining is older still: stop rather than fetch the
  // rest to discard them. Without this the first backfill pulled 138 pre-2026 orders it immediately threw
  // away — wasted requests, and exactly the volume that gets a scraper flagged. A few in a row rather
  // than one guards against dates arriving slightly out of order.
  const maxConsecutiveOld = 3;
  if (!existsSync(SAMS.outDir)) mkdirSync(SAMS.outDir, { recursive: true });
  const store = loadStore(SAMS.cacheFile);
  const now = new Date().toISOString();

  const browser = await chromium.connectOverCDP(CDP_URL).catch((e: Error) => {
    throw new Error(`Could not attach to Chrome at ${CDP_URL}: ${e.message}. Launch Chrome with --remote-debugging-port=9222 --user-data-dir=C:\\wm-chrome-profile and sign into samsclub.com first.`);
  });
  let extracted = 0, tooOld = 0, unsettled = 0, reconMismatch = 0, noItems = 0, failed = 0;
  let blocked = false, remaining = 0;
  try {
    const page = await samsPage(browser);
    const roster = await scrapeRoster(page, maxPages, pacer, yearFilter);
    console.log(`roster: ${roster.length} distinct order(s)`);
    // The roster has no dates, so "already cached" is the only cheap filter available up front.
    const missing = roster.filter((id) => !store.has(id));
    const todo = limit ? missing.slice(0, limit) : missing;
    console.log(`cached ${roster.length - missing.length} | to-fetch ${todo.length}${limit && missing.length > limit ? ` (capped from ${missing.length})` : ''}`);

    if (!todo.length) { console.log('nothing to fetch — every roster order is already cached'); }
    // One navigation teaches us the endpoint; the rest are plain requests.
    const fetcher = todo.length ? await makeOrderFetcher(page, todo[0]) : null;

    let consecutiveFailures = 0;
    let consecutiveOld = 0;
    let done = 0;
    for (const orderId of todo) {
      const w = await pacer.wait();
      if (w.long) console.log(`  … pausing ${(w.ms / 1000).toFixed(1)}s`);
      // The first order's detail already arrived with the seed navigation — don't request it twice.
      const raw = done === 0 && fetcher?.seed
        ? fetcher.seed
        : await fetcher!.fetch(orderId).catch(async (e: Error) => {
          await assertNotBlocked(page, `order ${orderId}`);
          console.error(`  ${orderId}: ${e.message}`);
          return null;
        });
      const p = raw ? parseSamsOrder(raw) : null;
      done++;
      if (!p) {
        failed++;
        consecutiveFailures++;
        console.error(`  ${orderId}: no parseable order detail (${consecutiveFailures} in a row)`);
        if (consecutiveFailures >= maxConsecutiveFailures) {
          remaining = todo.length - done;
          console.error(`\nSTOPPING: ${consecutiveFailures} consecutive failures — treating this as a soft block rather than continuing and leaving gaps.`);
          console.error(`  Check the Chrome window for a challenge, then re-run; ${remaining} order(s) were not attempted.`);
          blocked = true;
          break;
        }
        continue;
      }
      consecutiveFailures = 0;
      if (p.date < since) {
        tooOld++;
        consecutiveOld++;
        console.log(`  ${orderId}: ${p.date} < ${since} — skip`);
        if (consecutiveOld >= maxConsecutiveOld) {
          console.log(`\nReached ${consecutiveOld} orders older than ${since} in a row — the roster is newest-first, so the rest are older too. Stopping.`);
          break;
        }
        continue;
      }
      consecutiveOld = 0;
      if (p.chargeCents === 0) { console.log(`  ${orderId}: $0 total (unsettled/pending) — skip, retry later`); unsettled++; continue; }
      if (p.items.length === 0) { console.log(`  ${orderId}: no line items — skip`); noItems++; continue; }
      const recon = p.parsedTotalCents === p.chargeCents;
      if (!recon) reconMismatch++;
      store.put({
        orderId: p.orderId, date: p.date, totalCents: p.chargeCents,
        items: p.items, taxCents: p.taxCents, shippingCents: p.shippingCents,
        tipCents: p.tipCents, parsedTotalCents: p.parsedTotalCents, pdfPath: '', fetchedAt: now,
      });
      extracted++;
      console.log(`  ${p.orderId} ${p.date} items=${p.items.length} parsed=$${(p.parsedTotalCents / 100).toFixed(2)} charge=$${(p.chargeCents / 100).toFixed(2)} ${recon ? 'OK' : 'RECON-MISMATCH'}`);
    }
  } catch (e) {
    // A challenge is expected-ish and must not look like a crash: report it and still write the index
    // for whatever was cached before the block.
    if (e instanceof BlockedError) { blocked = true; console.error(`\nBLOCKED: ${e.message}`); }
    else throw e;
  } finally {
    await browser.close().catch(() => undefined);
  }

  const idx = ['order_id,date,total,items,parsed_total,reconciles'];
  for (const r of store.all()) {
    idx.push([r.orderId, r.date, (r.totalCents / 100).toFixed(2), String(r.items.length), (r.parsedTotalCents / 100).toFixed(2), String(r.parsedTotalCents === r.totalCents)].join(','));
  }
  writeFileSync(`${SAMS.outDir}/extraction-index.csv`, idx.join('\n'));
  console.log(`\nSAM'S EXTRACT ${blocked ? 'STOPPED EARLY' : 'done'}: +${extracted} new | ${tooOld} before ${since} | ${unsettled} unsettled($0) | ${reconMismatch} reconcile-mismatch | ${noItems} no-items | ${failed} failed. cache=${store.all().length}. wrote ${SAMS.outDir}/extraction-index.csv`);
  if (blocked) {
    console.log(`The cache is write-through, so re-running resumes from order ${store.all().length + 1} — nothing already fetched is re-requested.`);
    // Non-zero so the sweep records this as needing attention instead of a clean pass.
    process.exitCode = 5;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
