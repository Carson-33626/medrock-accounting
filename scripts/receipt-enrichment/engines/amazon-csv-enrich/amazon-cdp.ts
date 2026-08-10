// Attach to the user's REAL Chrome over CDP (Amazon fingerprints launched/automated browsers just like
// Walmart's PerimeterX). Prereq (one-time per session): the user launches Chrome with
//   chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\amz-chrome-profile
// and signs into the target Amazon Business login by hand.
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

export const CDP_URL = process.env.AMZ_CDP_URL ?? 'http://127.0.0.1:9222';

export function isAmazonUrl(url: string): boolean { return /^https?:\/\/([^/]+\.)?amazon\.com\//i.test(url); }

export async function connectChrome(cdpUrl: string = CDP_URL): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(cdpUrl);
  } catch (e) {
    throw new Error(
      `Could not attach to Chrome at ${cdpUrl}: ${(e as Error).message}. Launch Chrome with ` +
      `--remote-debugging-port=9222 --user-data-dir=C:\\amz-chrome-profile and sign into Amazon Business first.`,
    );
  }
}

export async function getAmazonPage(browser: Browser): Promise<Page> {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('Attached Chrome has no browser context.');
  const existing = ctx.pages().find((p) => isAmazonUrl(p.url()));
  return existing ?? (await ctx.newPage());
}

export async function withAmazonPage<T>(fn: (page: Page) => Promise<T>, cdpUrl: string = CDP_URL): Promise<T> {
  const browser = await connectChrome(cdpUrl);
  try {
    return await fn(await getAmazonPage(browser));
  } finally {
    await browser.close().catch(() => undefined);
  }
}
