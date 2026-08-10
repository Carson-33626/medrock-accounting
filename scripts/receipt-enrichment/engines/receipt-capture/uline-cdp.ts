// scripts/receipt-enrichment/engines/receipt-capture/uline-cdp.ts
//
// ULINE adapter — attaches to Carson's REAL Chrome over the DevTools Protocol instead of
// launching a browser (same technique as scripts/receipt-enrichment/engines/walmart-enrich/cdp-session.ts). ULINE runs
// Akamai Bot Manager + Riskified and fires a reCAPTCHA on the login POST even from a headed,
// automation-launched Chrome (see 2026-07-27 probe, uline-login-probe.ts: verdict CHALLENGE on
// all 3 accounts) — scripted login is NOT viable. Carson signs in by hand in his own Chrome;
// this adapter only ever performs authenticated navigation against a session he already holds.
//
// Bootstrap (Step 1, one-time per run session — Carson does this, not automation):
//   chrome.exe --remote-debugging-port=9222 --user-data-dir=<his normal profile dir>
//   (a dedicated desktop shortcut is fine) then sign into uline.com for the target entity
//   account by hand, clearing any captcha/challenge as a normal human.
//
// Multi-entity caveat: ULINE accounts are separate per entity (FL/TN/TX) and — unlike the
// Walmart adapter's --user-data-dir-per-entity approach — there is no evidence ULINE tolerates
// multiple simultaneous entity sessions in one Chrome profile, so a multi-entity backfill/run
// requires Carson to sign out of one account and into the next between runs. The `--entity` flag
// passed to the runner (task 9, run-uline.ts) is a LABEL ONLY — it does NOT select which account
// is used; account identity comes from whoever is actually signed in in Chrome right now. The
// runner MUST NOT trust --entity blindly: before scraping, it should call getUlineAccountName()
// (below) and compare the signed-in account's company-name header against an
// ULINE_ACCOUNT_<ENT> env label (e.g. ULINE_ACCOUNT_FL="MEDROCK PHARMACY"); a mismatch is a hard
// stop, never a silent proceed against the wrong entity's data. That comparison is deliberately
// NOT implemented in this file (this file only exposes the primitive, getUlineAccountName) —
// task 9 owns the --entity contract and the stop/continue decision.
import { connectChrome } from '../walmart-enrich/cdp-session';
import type { Browser, Locator, Page } from '@playwright/test';
import { rowsToInvoices, shouldKeepScrolling } from './uline-roster';
import { PERIOD_FLOOR } from './cli-args';
import type { ColumnMap, UlineInvoice } from './uline-roster';

export const ULINE_CDP_URL = process.env.ULINE_CDP_URL ?? 'http://127.0.0.1:9222';
const ORDER_HISTORY_URL = 'https://www.uline.com/MyAccount/MyOrderHistory';
const GRID_SELECTOR = '.invoicedOrders.k-grid';
// Hard safety cap on the endless-scroll loop in case a site change breaks the growth/date
// stopping conditions. ~100 line rows load per scroll, so this covers ~6,000 line rows.
const DEFAULT_MAX_SCROLLS = 60;
// Matches run-uline.ts's own --since default (the 2026 period floor); scrapeUlineRoster is also
// called by probes that pass nothing, and a roster that silently stops at "recent" is the bug
// this replaced.
const DEFAULT_SINCE = PERIOD_FLOOR;
const SETTLE_MS = 1200;
const PDF_FETCH_TIMEOUT_MS = 30_000;

export type { UlineInvoice } from './uline-roster';

export class UlineInvoicePdfError extends Error {}

function isSignInUrl(url: string): boolean {
  return /\/signin/i.test(url);
}

function assertNotSignIn(page: Page): void {
  if (isSignInUrl(page.url())) {
    throw new Error('ULINE_SIGNIN_REQUIRED: sign in to ULINE in your Chrome, then re-run');
  }
}

// Find an existing ULINE tab (preferred — it's already warm and authenticated), else open one
// at MyOrderHistory. Never touches a login form; a /SignIn landing is a hard stop for a human.
async function getUlinePage(browser: Browser): Promise<Page> {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('Attached Chrome has no browser context.');
  const existing = ctx.pages().find((p) => /uline\.com/i.test(p.url()));
  const page = existing ?? (await ctx.newPage());
  if (!existing) {
    await page.goto(ORDER_HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(SETTLE_MS);
  }
  assertNotSignIn(page);
  return page;
}

// Attach, run fn against an authenticated ULINE page, then DETACH. Never closes Carson's Chrome —
// browser.close() on a CDP-attached browser only drops our connection (see cdp-session.ts).
export async function withUlinePage<T>(
  fn: (page: Page) => Promise<T>,
  cdpUrl: string = ULINE_CDP_URL,
): Promise<T> {
  const browser = await connectChrome(cdpUrl);
  try {
    const page = await getUlinePage(browser);
    return await fn(page);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// Company-name header on MyOrderHistory (evidence: docs/Uline/Uline_ Order History.mhtml line
// 719, `<span id="CompanyName">MEDROCK PHARMACY</span>`) — the signal task 9 uses to verify the
// signed-in account matches the expected entity before trusting any scraped data.
export async function getUlineAccountName(page: Page): Promise<string> {
  assertNotSignIn(page);
  const name = await page.locator('#CompanyName').first().textContent().catch(() => null);
  if (!name) throw new Error('ULINE: could not read #CompanyName header — page shape changed or not on MyOrderHistory.');
  return name.trim();
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

// The invoiced-orders Kendo grid renders ONE ROW PER PRODUCT LINE, not one row per order — Date /
// Order # / Invoice / Folio # / PO # repeat identically across every line of a multi-item order
// (evidence: captured grid header carries Category/Model #/Description/Qty/etc alongside the
// order-level columns). Header cells never move, but which grid COLUMN each field lives in is
// read from the `data-title` attribute at scrape time (never hardcoded indices, and never the
// row `data-uid`/th `id` — those are session GUIDs, see docs/Uline/Uline_ Order History.mhtml).
// Kendo renders a "Floating" clone of the grid (sticky-header behavior — evidence: TWO elements
// match `.invoicedOrders.k-grid` in the captured page, ids "Invoic..." and "FloatingInvoic...").
// Every locator below is scoped to `.first()` of this selector so header/row indices always come
// from ONE grid instance — querying across both would double-count rows and, worse, could
// misalign the column map if the clone's header cell count ever differs.
function grid(page: Page): Locator {
  return page.locator(GRID_SELECTOR).first();
}

async function readColumnMap(page: Page): Promise<ColumnMap> {
  const headerCells = grid(page).locator('thead th');
  const count = await headerCells.count();
  if (count === 0) throw new Error('ULINE: invoiced-orders grid header not found — page shape changed or not signed in.');
  const map = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const title = await headerCells.nth(i).getAttribute('data-title');
    if (title) map.set(normalizeHeader(title), i);
  }
  const date = map.get('date');
  const orderNumber = map.get('order');
  const invoiceNumber = map.get('invoice');
  if (date === undefined || orderNumber === undefined || invoiceNumber === undefined) {
    throw new Error(
      `ULINE: expected Date/Order #/Invoice columns not found in header (got: ${[...map.keys()].join(', ')}).`,
    );
  }
  return { date, orderNumber, invoiceNumber };
}

// Pull the whole grid body out of the DOM in ONE evaluate, then hand the raw cell text to the
// pure collapser. Reading it row-by-row through locators is not just slower — it also loses the
// top-to-bottom ordering guarantee that the date carry-down depends on.
async function readGridRows(page: Page, cols: ColumnMap): Promise<UlineInvoice[]> {
  const raw: string[][] = await page.evaluate((sel: string) => {
    const g = document.querySelector(sel);
    if (!g) return [];
    return [...g.querySelectorAll('tbody tr.k-table-row')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim()),
    );
  }, GRID_SELECTOR);
  return rowsToInvoices(raw, cols);
}

async function countGridRows(page: Page): Promise<number> {
  return page.evaluate(
    (sel: string) => document.querySelectorAll(`${sel} tbody tr.k-table-row`).length,
    GRID_SELECTOR,
  );
}

/**
 * Scrape the invoiced-orders roster from MyOrderHistory back to `since`, deduped to one entry per
 * invoice (the grid is line-item-granular — see readColumnMap comment).
 *
 * There is NO pager on this page: the grid is endless-scroll, loading ~100 more line rows each
 * time the bottom is reached (verified live 2026-08-03: 0 -> 100 -> 200 -> 300 -> 400 -> 500).
 * The previous implementation looked for a Kendo pager, found nothing, and read "control missing"
 * as "end of roster" — silently capping the roster at the first ~100 line rows (~6 weeks of a
 * 2-year history) with no error. Scroll until the row count stops growing, until the oldest
 * loaded row predates `since`, or until the safety cap.
 */
export async function scrapeUlineRoster(
  page: Page,
  opts: { since?: string; maxScrolls?: number } = {},
): Promise<UlineInvoice[]> {
  const since = opts.since ?? DEFAULT_SINCE;
  const maxScrolls = opts.maxScrolls ?? DEFAULT_MAX_SCROLLS;
  if (!/MyOrderHistory/i.test(page.url())) {
    await page.goto(ORDER_HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(SETTLE_MS);
  }
  assertNotSignIn(page);
  await page.waitForSelector(GRID_SELECTOR, { timeout: 20_000 });

  let previousRowCount = -1;
  let currentRowCount = await countGridRows(page);
  let scrolls = 0;
  let oldestDate = '';

  for (;;) {
    if (!shouldKeepScrolling({ previousRowCount, currentRowCount, oldestDate, since, scrolls, maxScrolls })) break;

    await page.evaluate((sel: string) => {
      const content = document.querySelector(`${sel} .k-grid-content`);
      if (content instanceof HTMLElement) content.scrollTop = content.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
    }, GRID_SELECTOR);
    await page.waitForTimeout(SETTLE_MS);
    assertNotSignIn(page);

    scrolls++;
    previousRowCount = currentRowCount;
    currentRowCount = await countGridRows(page);

    const cols = await readColumnMap(page);
    const seen = await readGridRows(page, cols);
    const dated = seen.map((r) => r.date).filter((d) => d !== '').sort();
    oldestDate = dated[0] ?? '';
    console.log(`  ULINE roster scroll ${scrolls}: ${currentRowCount} line row(s), ${seen.length} invoice(s), oldest ${oldestDate || 'n/a'}`);
  }

  if (scrolls >= maxScrolls) {
    console.log(`  [warn] hit the ${maxScrolls}-scroll safety cap — roster may be incomplete before ${since}`);
  }

  const cols = await readColumnMap(page);
  const roster = await readGridRows(page, cols);
  console.log(`  ULINE roster: ${currentRowCount} line row(s) -> ${roster.length} invoice(s) after ${scrolls} scroll(s)`);
  return roster;
}

function isPdfBuffer(buf: Buffer): boolean {
  return buf.subarray(0, 4).toString('latin1') === '%PDF';
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Click a trigger and capture whatever Chrome downloads as a result. Download-event capture is
// proven to work over a CDP-attached real Chrome (see scripts/receipt-enrichment/engines/amazon-csv-enrich/report-download.ts,
// "confirmed live" 2026-07-22) — the listener MUST be armed before the click.
async function fetchPdfViaDownloadClick(page: Page, clickSelector: string): Promise<Buffer | null> {
  const trigger = page.locator(clickSelector).first();
  if ((await trigger.count()) === 0) return null;
  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
  await trigger.click({ timeout: 8_000 }).catch(() => undefined);
  const download = await downloadPromise;
  if (!download) return null;
  const stream = await download.createReadStream().catch(() => null);
  if (!stream) return null;
  const buf = await streamToBuffer(stream);
  return isPdfBuffer(buf) ? buf : null;
}

/**
 * Fetch one invoice's PDF via the InvoiceDetail page's "Email/PDF" modal (confirmed live
 * 2026-07-27 — see task-7 report). The earlier assumption that MyOrderHistory's Export-tab popup
 * (`#ExportOrderHistoryTabLink` / `li.onDemandPdfItem`) served a per-invoice PDF was wrong: that
 * popup only exports the roster GRID as CSV/Excel — its "PDF" li is a mislabeled leftover whose
 * onclick actually calls `Export('csv')` (icon says PDF, span says CSV, function exports CSV, no
 * PDF option exists there at all).
 *
 * The real flow, confirmed live against invoice 210990196 (151,281 bytes, `%PDF` magic):
 *   1. Navigate to /MyAccount/InvoiceDetail?email=false&OrderHistory=true&invoice=<inv>.
 *   2. Click `#lnkEmailModal_<inv>` ("Email/PDF" link) — opens the download/email modal
 *      (`#downloadOrEmailPartialForm`).
 *   3. Click `#downloadLinkText` inside it (onclick calls `downloadImageFromModal(<inv>)`, which
 *      navigates a hidden `iframe#downloadPDF` to
 *      `/Shared/DownloadOrEmail/DownloadDocument?idList=...&documentType=1&downloadFileName=...`)
 *      and capture the resulting Chrome `download` event via `fetchPdfViaDownloadClick`.
 * Wrapped with a 30s overall timeout; throws UlineInvoicePdfError with a specific reason if the
 * flow fails, so a human can inspect the live modal and extend this function.
 *
 * ULINE regenerates this PDF per request (confirmed: same invoice fetched twice yielded 150,047
 * and 151,281 bytes) — byte size and internal structure are NOT stable, but extracted text was
 * verified identical across both fetches. Never dedupe or key receipts by content hash; always use
 * the invoice/order number as the idempotency key.
 */
export async function fetchUlineInvoicePdf(page: Page, inv: UlineInvoice): Promise<Buffer> {
  const attempt = async (): Promise<Buffer> => {
    assertNotSignIn(page);

    const detailUrl =
      `https://www.uline.com/MyAccount/InvoiceDetail?email=false&OrderHistory=true&invoice=${encodeURIComponent(inv.invoiceNumber)}`;
    if (page.url() !== detailUrl) {
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(SETTLE_MS);
      assertNotSignIn(page);
    }

    const emailModalLink = page.locator(`#lnkEmailModal_${inv.invoiceNumber}`).first();
    if ((await emailModalLink.count()) === 0) {
      throw new UlineInvoicePdfError(
        `ULINE invoice ${inv.invoiceNumber} (order ${inv.orderNumber}): #lnkEmailModal_${inv.invoiceNumber} not found on InvoiceDetail — page shape changed.`,
      );
    }
    await emailModalLink.click({ timeout: 8_000 });
    await page.waitForTimeout(1_000);

    const downloadLink = page.locator('#downloadLinkText').first();
    if ((await downloadLink.count()) === 0) {
      throw new UlineInvoicePdfError(
        `ULINE invoice ${inv.invoiceNumber} (order ${inv.orderNumber}): Email/PDF modal opened but #downloadLinkText not found.`,
      );
    }
    const pdf = await fetchPdfViaDownloadClick(page, '#downloadLinkText');
    if (pdf) return pdf;

    throw new UlineInvoicePdfError(
      `ULINE invoice ${inv.invoiceNumber} (order ${inv.orderNumber}): Email/PDF modal download click did not yield real %PDF bytes.`,
    );
  };

  return Promise.race([
    attempt(),
    new Promise<Buffer>((_, reject) =>
      setTimeout(
        () => reject(new UlineInvoicePdfError(`ULINE invoice ${inv.invoiceNumber}: PDF fetch timed out after ${PDF_FETCH_TIMEOUT_MS}ms`)),
        PDF_FETCH_TIMEOUT_MS,
      ),
    ),
  ]);
}
