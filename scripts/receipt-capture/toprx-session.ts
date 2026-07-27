// scripts/receipt-capture/toprx-session.ts
// Authenticated TopRx page factory. Reuses saved storageState; transparently re-logs-in when the
// session lapses (scripted login is proven safe for TopRx — no captcha; see 2026-07-27 probes).
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Entity } from '../ramp-split-push/types';

const STATE_DIR = join(__dirname, '.state');
const BASE = 'https://b2b.toprx.com';

function creds(entity: Entity): { user: string; pass: string } {
  const user = process.env[`TopRX_${entity}`];
  const pass = process.env[`TopRX_${entity}_Pass`];
  if (!user || !pass) throw new Error(`Missing TopRX_${entity} / TopRX_${entity}_Pass in .env.local`);
  return { user, pass };
}

// Positive assertion: we only trust the page is authenticated on the real b2b app's order-history
// route. Any other landing spot (the /login page, the public toprx.com marketing site, an
// unrelated redirect) counts as unauthenticated — see 2026-07-27 finding where a stale session
// silently bounced to the marketing homepage instead of /login.
function isAuthenticatedOrderHistory(page: Page): boolean {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return false;
  }
  return url.host === 'b2b.toprx.com' && url.pathname.includes('/order/history');
}

async function login(page: Page, entity: Entity): Promise<void> {
  const { user, pass } = creds(entity);
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  const okBtn = page.getByRole('button', { name: /^ok$/i }).first();
  if (await okBtn.isVisible().catch(() => false)) await okBtn.click().catch(() => null);
  await page.fill('#Email, input[name="Email"]', user);
  await page.fill('#Password, input[type="password"]', pass);
  const remember = page.locator('#RememberMe, input[name="RememberMe"]').first();
  if (await remember.isVisible().catch(() => false)) await remember.check().catch(() => null);
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => null),
    page.locator('button[type="submit"], input[type="submit"], button:has-text("Log in")').first().click(),
  ]);
  await page.waitForTimeout(2500);
  const postLoginUrl = new URL(page.url());
  if (postLoginUrl.host !== 'b2b.toprx.com' || /\/login/i.test(postLoginUrl.pathname)) {
    throw new Error(
      `TopRx ${entity}: login did not stick (check creds / possible challenge) — landed on ${page.url()}`
    );
  }
}

export async function withTopRxPage<T>(entity: Entity, fn: (page: Page) => Promise<T>): Promise<T> {
  mkdirSync(STATE_DIR, { recursive: true });
  const statePath = join(STATE_DIR, `toprx-${entity}.json`);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(existsSync(statePath) ? { storageState: statePath } : {});
    const page = await context.newPage();
    await page.goto(`${BASE}/order/history`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    if (!isAuthenticatedOrderHistory(page)) {
      await login(page, entity);
      await page.goto(`${BASE}/order/history`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
      if (!isAuthenticatedOrderHistory(page)) {
        throw new Error(`TopRx ${entity}: still unauthenticated after re-login — landed on ${page.url()}`);
      }
    }
    await context.storageState({ path: statePath });
    return await fn(page);
  } finally {
    await browser.close();
  }
}
