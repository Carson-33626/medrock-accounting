// scripts/receipt-capture/uline-cdp.ts
//
// ULINE adapter — attaches to Carson's REAL Chrome over the DevTools Protocol instead of
// launching a browser (same technique as scripts/walmart-enrich/cdp-session.ts). ULINE runs
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

export const ULINE_CDP_URL = process.env.ULINE_CDP_URL ?? 'http://127.0.0.1:9222';
const ORDER_HISTORY_URL = 'https://www.uline.com/MyAccount/MyOrderHistory';
const GRID_SELECTOR = '.invoicedOrders.k-grid';
const NEXT_PAGER_SELECTOR = '.k-pager-nav[title*="next" i]';
// Hard safety cap on pagination in case a bug (or a site change) breaks the pager-disabled
// stopping condition — matches the convention in toprx-roster.ts.
const DEFAULT_MAX_PAGES = 100;
const SETTLE_MS = 1200;
const PDF_FETCH_TIMEOUT_MS = 30_000;

export interface UlineInvoice {
  invoiceNumber: string;
  orderNumber: string;
  date: string;
}

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

// MM/DD/YYYY -> YYYY-MM-DD. ULINE's Date column renders as plain text in this format (evidence:
// "07/23/2026" in the captured grid); anything else is left as-is defensively rather than guessed.
function normalizeDate(raw: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : raw.trim();
}

interface ColumnMap {
  date: number;
  orderNumber: number;
  invoiceNumber: number;
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

async function readGridRows(page: Page, cols: ColumnMap): Promise<UlineInvoice[]> {
  const rows = grid(page).locator('tbody tr.k-table-row');
  const rowCount = await rows.count();
  const out: UlineInvoice[] = [];
  for (let r = 0; r < rowCount; r++) {
    const cells = rows.nth(r).locator('td');
    const [dateRaw, orderNumber, invoiceNumber] = await Promise.all([
      cells.nth(cols.date).textContent(),
      cells.nth(cols.orderNumber).textContent(),
      cells.nth(cols.invoiceNumber).textContent(),
    ]);
    const inv = (invoiceNumber ?? '').trim();
    const ord = (orderNumber ?? '').trim();
    if (!inv || !ord) continue; // un-invoiced / malformed row — nothing to match a receipt against
    out.push({ invoiceNumber: inv, orderNumber: ord, date: normalizeDate(dateRaw ?? '') });
  }
  return out;
}

async function isNextDisabled(page: Page): Promise<boolean> {
  const next = page.locator(NEXT_PAGER_SELECTOR).first();
  if ((await next.count()) === 0) return true;
  return next.evaluate(
    (el) => el.classList.contains('k-disabled') || el.getAttribute('aria-disabled') === 'true',
  );
}

/**
 * Scrape the FULL invoiced-orders roster from MyOrderHistory, deduped to one entry per invoice
 * (the grid is line-item-granular — see readColumnMap comment). Pages through the Kendo pager
 * until its "next" control is disabled/missing, a page adds no new invoices (loop guard), or
 * `maxPages` is hit.
 */
export async function scrapeUlineRoster(page: Page, opts: { maxPages?: number } = {}): Promise<UlineInvoice[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  if (!/MyOrderHistory/i.test(page.url())) {
    await page.goto(ORDER_HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(SETTLE_MS);
  }
  assertNotSignIn(page);
  await page.waitForSelector(GRID_SELECTOR, { timeout: 20_000 });

  const byInvoice = new Map<string, UlineInvoice>();
  for (let p = 1; p <= maxPages; p++) {
    const cols = await readColumnMap(page);
    const rows = await readGridRows(page, cols);
    let added = 0;
    for (const row of rows) {
      if (!byInvoice.has(row.invoiceNumber)) { byInvoice.set(row.invoiceNumber, row); added++; }
    }
    console.log(`  ULINE roster page ${p}: ${rows.length} line row(s), +${added} new invoice(s)`);

    if (await isNextDisabled(page)) { console.log('  next-page control disabled/missing — end of roster'); break; }
    if (added === 0 && p > 1) { console.log('  page added no new invoices — stopping (looped/duplicate)'); break; }

    await page.locator(NEXT_PAGER_SELECTOR).first().click({ timeout: 8_000 }).catch((e) => {
      console.log(`  next-page click failed: ${(e as Error).message.split('\n')[0]}`);
    });
    await page.waitForTimeout(SETTLE_MS);
    assertNotSignIn(page);
  }
  return [...byInvoice.values()];
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
// proven to work over a CDP-attached real Chrome (see scripts/amazon-csv-enrich/report-download.ts,
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
