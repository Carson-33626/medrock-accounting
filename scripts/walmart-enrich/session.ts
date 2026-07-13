// Reuse a persisted, logged-in Walmart session. Bootstrap once (headed) via bootstrap-login.ts;
// runs reuse the storageState headless. On an expired session the caller detects a login-wall
// (URL contains "/account/login" or "/blocked") and prompts a re-bootstrap.
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';

export const SESSION_DIR = 'scripts/walmart-enrich/.wm-session';
export const STATE_PATH = `${SESSION_DIR}/state.json`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function sessionExists(): boolean { return existsSync(STATE_PATH); }

export async function withWalmartContext<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  if (!sessionExists()) throw new Error(`No Walmart session at ${STATE_PATH}. Run: npx tsx scripts/walmart-enrich/bootstrap-login.ts`);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STATE_PATH, userAgent: UA, viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    try { return await fn(page); } finally { await context.close(); }
  } finally {
    await browser.close();
  }
}

export function isLoginWall(url: string): boolean {
  return /\/account\/login|\/blocked|\/sign-?in/i.test(url);
}
