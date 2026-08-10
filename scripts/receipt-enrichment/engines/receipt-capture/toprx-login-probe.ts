// DUMMY RUN: scripted (headless Playwright) login against b2b.toprx.com for all 3 entity
// accounts. Verifies the session works by loading /order/history, saves storageState on
// success. Reads TopRX_{FL,TN,TX} / TopRX_{FL,TN,TX}_Pass from web/.env.local.
// No Ramp/QB writes; nothing ordered or changed on TopRx.
// Run from web/ dir:  npx tsx scripts/receipt-enrichment/engines/receipt-capture/toprx-login-probe.ts [--headed] [--entity=FL]
import '../ramp-split-push/load-env';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { RC } from '../../paths';

type Ent = 'FL' | 'TN' | 'TX';
const ENTITIES: Ent[] = ['FL', 'TN', 'TX'];
// Consolidated cache, not next to this module — this probe can WRITE session state (below), so a
// stale __dirname-relative path here would strand a good login where nothing reads it.
const STATE_DIR = RC.state;
const SHOT_DIR = RC.probeShots;

interface ProbeResult {
  entity: Ent;
  verdict: 'LOGIN_OK' | 'BAD_CREDENTIALS' | 'BLOCKED_OR_CHALLENGE' | 'ERROR';
  finalUrl: string;
  detail: string;
  orderHistoryLoads: boolean;
}

function creds(entity: Ent): { user: string; pass: string } {
  const user = process.env[`TopRX_${entity}`];
  const pass = process.env[`TopRX_${entity}_Pass`];
  if (!user || !pass) throw new Error(`Missing TopRX_${entity} / TopRX_${entity}_Pass in .env.local`);
  return { user, pass };
}

async function bodyText(page: Page): Promise<string> {
  return ((await page.textContent('body').catch(() => '')) ?? '').replace(/\s+/g, ' ');
}

async function probe(browser: Browser, entity: Ent): Promise<ProbeResult> {
  const { user, pass } = creds(entity);
  const context = await browser.newContext();
  const page = await context.newPage();
  const shot = (name: string): Promise<unknown> =>
    page.screenshot({ path: join(SHOT_DIR, `toprx-${entity}-${name}.png`) }).catch(() => null);
  try {
    await page.goto('https://b2b.toprx.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    // cookie-consent modal blocks the form
    const okBtn = page.getByRole('button', { name: /^ok$/i }).first();
    if (await okBtn.isVisible().catch(() => false)) await okBtn.click().catch(() => null);
    await page.fill('#Email, input[name="Email"]', user);
    await page.fill('#Password, input[type="password"]', pass);
    const remember = page.locator('#RememberMe, input[name="RememberMe"]').first();
    if (await remember.isVisible().catch(() => false)) await remember.check().catch(() => null);
    await shot('filled');
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => null),
      page.locator('button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")').first().click(),
    ]);
    await page.waitForTimeout(3500);
    const afterUrl = page.url();
    const body = await bodyText(page);
    await shot('post-login');
    if (/unsuccessful|credentials|incorrect|not found/i.test(body) && /login/i.test(afterUrl)) {
      return { entity, verdict: 'BAD_CREDENTIALS', finalUrl: afterUrl, detail: body.slice(0, 160), orderHistoryLoads: false };
    }
    if (/verify you are|not a robot|challenge|attention required/i.test(body)) {
      return { entity, verdict: 'BLOCKED_OR_CHALLENGE', finalUrl: afterUrl, detail: body.slice(0, 160), orderHistoryLoads: false };
    }
    await page.goto('https://b2b.toprx.com/order/history', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000); // ajax grid
    const ohUrl = page.url();
    const ohBody = await bodyText(page);
    await shot('order-history');
    const loads = /order\/history/i.test(ohUrl) && !/login/i.test(ohUrl);
    if (loads) {
      mkdirSync(STATE_DIR, { recursive: true });
      await context.storageState({ path: join(STATE_DIR, `toprx-${entity}.json`) });
    }
    return {
      entity,
      verdict: loads ? 'LOGIN_OK' : 'ERROR',
      finalUrl: ohUrl,
      detail: loads ? `order history loaded; body~"${ohBody.slice(0, 120)}"` : ohBody.slice(0, 160),
      orderHistoryLoads: loads,
    };
  } catch (e) {
    await shot('exception');
    return { entity, verdict: 'ERROR', finalUrl: page.url(), detail: String(e).slice(0, 200), orderHistoryLoads: false };
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const headed = process.argv.includes('--headed');
  const only = process.argv.find((a) => a.startsWith('--entity='))?.split('=')[1];
  const targets = only ? ENTITIES.filter((e) => e === only) : ENTITIES;
  mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: !headed });
  const results: ProbeResult[] = [];
  for (const entity of targets) {
    console.error(`Probing TopRx ${entity} (${headed ? 'headed' : 'headless'})...`);
    results.push(await probe(browser, entity));
  }
  await browser.close();
  console.log('\n================ TOPRX SCRIPTED-LOGIN PROBE ================');
  for (const r of results) {
    console.log(`${r.entity}: ${r.verdict} | orderHistory=${r.orderHistoryLoads} | ${r.finalUrl}`);
    console.log(`    ${r.detail}`);
  }
  console.log(`\nScreenshots: ${SHOT_DIR}`);
  console.log(`Session states (on success): ${STATE_DIR}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
