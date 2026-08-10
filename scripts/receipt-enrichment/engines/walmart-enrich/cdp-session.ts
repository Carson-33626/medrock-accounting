// Attach to the user's REAL Chrome over the DevTools Protocol instead of launching a browser.
// Walmart's PerimeterX hard-blocks Playwright-LAUNCHED Chromium (even a human can't clear the
// "press & hold" in it), but ATTACHING to a real Chrome the user logged into themselves is invisible
// to that fingerprinting. Prereq (one-time per session): the user launches Chrome with
//   chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\wm-chrome-profile
// then signs into Walmart by hand (clearing any challenge as a normal human).
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

export const CDP_URL = process.env.WM_CDP_URL ?? 'http://127.0.0.1:9222';

export async function connectChrome(cdpUrl: string = CDP_URL): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(cdpUrl);
  } catch (e) {
    throw new Error(
      `Could not attach to Chrome at ${cdpUrl}: ${(e as Error).message}. Launch Chrome with ` +
      `--remote-debugging-port=9222 --user-data-dir=C:\\wm-chrome-profile and sign into Walmart first.`,
    );
  }
}

// Find an existing Walmart tab (preferred — it's already warm), else open a fresh page in context 0.
export async function getWalmartPage(browser: Browser): Promise<Page> {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('Attached Chrome has no browser context.');
  const existing = ctx.pages().find((p) => /walmart\.com/i.test(p.url()));
  return existing ?? (await ctx.newPage());
}

// Attach, run fn against a Walmart page, then DETACH. Never closes the user's Chrome — browser.close()
// on a CDP-attached browser only drops our connection.
export async function withWalmartPage<T>(fn: (page: Page) => Promise<T>, cdpUrl: string = CDP_URL): Promise<T> {
  const browser = await connectChrome(cdpUrl);
  try {
    return await fn(await getWalmartPage(browser));
  } finally {
    await browser.close().catch(() => undefined);
  }
}
