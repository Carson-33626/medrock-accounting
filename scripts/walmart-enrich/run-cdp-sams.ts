// EXTRACT runner for Sam's Club (CDP method) — the Sam's counterpart to run-cdp.ts. Attaches to the
// user's real Chrome, pages the purchase-history roster, fetches each uncached order's detail, and writes
// through to the SAMS extraction cache. Extract-only: no Ramp calls, no writes outside the local cache.
// Resumable (write-through) and idempotent (skips already-cached orders).
//   npx tsx scripts/walmart-enrich/run-cdp-sams.ts [--since 2026-01-01] [--pages 100] [--limit N]
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

// Page the roster by clicking the "Next page" chevron and capturing the PurchaseHistoryV2 response it
// fires — the same control and the same approach as Walmart's cdp-roster.ts. The cursor travels inside
// the GraphQL `variables`, not the page URL, so it cannot be driven by navigation.
const NEXT_BTN = '[data-automation-id="next-pages-button"]';

async function scrapeRoster(page: Page, maxPages: number, pacer: Pacer): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const take = (body: RawHistory, label: string): number => {
    const { orderIds, nextCursor } = parseSamsRoster(body);
    let added = 0;
    for (const id of orderIds) if (!seen.has(id)) { seen.add(id); ids.push(id); added++; }
    console.log(`  roster ${label}: ${orderIds.length} order(s), +${added} new${nextCursor ? '' : ' (last page)'}`);
    return added;
  };

  const first: Promise<Response | null> = page.waitForResponse((r) => ROSTER_CALL.test(r.url()), { timeout: 30000 }).catch(() => null);
  await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const firstResp = await first;
  if (!firstResp) {
    await assertNotBlocked(page, 'the order list');
    throw new Error('No PurchaseHistoryV2 response on /orders — signed out, or the page shape changed.');
  }
  take(JSON.parse(await firstResp.text()) as RawHistory, 'page 1');

  for (let p = 2; p <= maxPages; p++) {
    const next = page.locator(NEXT_BTN);
    if (!(await next.count()) || await next.first().isDisabled().catch(() => false)) {
      console.log(`  Next button gone — end of history after ${p - 1} page(s)`);
      break;
    }
    // Pause BEFORE the click: the gap between a page rendering and a human clicking "next" is the
    // signal being imitated.
    const w = await pacer.wait();
    const respP: Promise<Response | null> = page.waitForResponse((r) => ROSTER_CALL.test(r.url()), { timeout: 20000 }).catch(() => null);
    await next.first().scrollIntoViewIfNeeded().catch(() => undefined);
    await next.first().click({ timeout: 8000 }).catch((e: Error) => console.log(`  next click err p${p}: ${e.message.split('\n')[0]}`));
    const resp = await respP;
    if (!resp) {
      await assertNotBlocked(page, `roster page ${p}`);
      console.log(`  no roster response on page ${p} — stopping`);
      break;
    }
    const added = take(JSON.parse(await resp.text()) as RawHistory, `page ${p}${w.long ? ' (after long pause)' : ''}`);
    if (added === 0) { console.log(`  page ${p} added nothing new — stopping (looped/duplicate)`); break; }
  }
  return ids;
}

// Navigating to /orders/<id> fires getOrder; capture it rather than re-deriving the hashed URL.
async function fetchOrder(page: Page, orderId: string): Promise<RawSamsOrder | null> {
  const respP: Promise<Response | null> = page.waitForResponse((r) => DETAIL_CALL.test(r.url()), { timeout: 25000 }).catch(() => null);
  await page.goto(`${ORDERS_URL}/${orderId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const resp = await respP;
  if (!resp) {
    // No detail call means either a challenge or a changed page — distinguish, because one is fatal
    // for the run and the other is a per-order miss.
    await assertNotBlocked(page, `order ${orderId}`);
    return null;
  }
  const body = JSON.parse(await resp.text()) as { data?: { order?: RawSamsOrder } };
  return body?.data?.order ?? null;
}

async function main(): Promise<void> {
  const since = arg('--since', '2026-01-01');
  const maxPages = Number(arg('--pages', '100')) || 100;
  const limit = Number(arg('--limit', '0')) || 0;
  const pacer = new Pacer({
    minMs: Number(arg('--min-delay', String(DEFAULTS.minMs))) || DEFAULTS.minMs,
    maxMs: Number(arg('--max-delay', String(DEFAULTS.maxMs))) || DEFAULTS.maxMs,
    longEvery: Number(arg('--long-every', String(DEFAULTS.longEvery))),
  });
  // Consecutive detail failures almost always mean a soft block rather than N odd orders; stopping keeps
  // a blocked run from silently producing a half-empty cache that reads like "these orders don't exist".
  const maxConsecutiveFailures = 3;
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
    const roster = await scrapeRoster(page, maxPages, pacer);
    console.log(`roster: ${roster.length} distinct order(s)`);
    // The roster has no dates, so "already cached" is the only cheap filter available up front.
    const missing = roster.filter((id) => !store.has(id));
    const todo = limit ? missing.slice(0, limit) : missing;
    console.log(`cached ${roster.length - missing.length} | to-fetch ${todo.length}${limit && missing.length > limit ? ` (capped from ${missing.length})` : ''}`);

    let consecutiveFailures = 0;
    let done = 0;
    for (const orderId of todo) {
      const w = await pacer.wait();
      if (w.long) console.log(`  … pausing ${(w.ms / 1000).toFixed(1)}s`);
      const raw = await fetchOrder(page, orderId);
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
      if (p.date < since) { console.log(`  ${orderId}: ${p.date} < ${since} — skip`); tooOld++; continue; }
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
