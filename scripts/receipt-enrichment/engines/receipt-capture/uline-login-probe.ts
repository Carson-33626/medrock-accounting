// DUMMY RUN: can a scripted (headless Playwright) login get past ULINE's bot screening?
// Reads Uline_{FL,TN,TX} / Uline_{FL,TN,TX}_Pass from web/.env.local. Logs in, verifies the
// session actually works by loading /MyAccount/MyOrderHistory, and reports a verdict per
// account. Saves storageState on success (reused by the future capture adapter). No Ramp/QB
// writes; nothing ordered or changed on ULINE.
// Run from web/ dir:  npx tsx scripts/receipt-enrichment/engines/receipt-capture/uline-login-probe.ts [--headed]
import '../ramp-split-push/load-env';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { RC } from '../../paths';

type UlineEntity = 'FL' | 'TN' | 'TX';
const ENTITIES: UlineEntity[] = ['FL', 'TN', 'TX'];
// Consolidated cache, not next to this module — see toprx-login-probe.ts.
const STATE_DIR = RC.state;
const SHOT_DIR = RC.probeShots;

interface ProbeResult {
  entity: UlineEntity;
  verdict: 'LOGIN_OK' | 'BAD_CREDENTIALS' | 'BOT_BLOCKED' | 'CHALLENGE' | 'ERROR';
  finalUrl: string;
  detail: string;
  orderHistoryLoads: boolean;
}

function creds(entity: UlineEntity): { user: string; pass: string } {
  const user = process.env[`Uline_${entity}`];
  const pass = process.env[`Uline_${entity}_Pass`];
  if (!user || !pass) throw new Error(`Missing Uline_${entity} / Uline_${entity}_Pass in .env.local`);
  return { user, pass };
}

async function pageSignals(page: Page): Promise<{ blocked: boolean; badCreds: boolean; challenge: boolean; detail: string }> {
  const body = (await page.textContent('body').catch(() => '')) ?? '';
  const title = await page.title().catch(() => '');
  const blocked =
    /access denied|reference #\d|request unsuccessful|pardon our interruption/i.test(body) || /access denied/i.test(title);
  const badCreds = /(email|password).{0,60}(incorrect|invalid|not match|not recognized)|invalid (login|credentials)/i.test(body);
  const challenge = (await page.locator('iframe[src*="captcha"], .g-recaptcha, #challenge-form').count()) > 0;
  const snippet = body.replace(/\s+/g, ' ').slice(0, 160);
  return { blocked, badCreds, challenge, detail: `title="${title}" body~"${snippet}"` };
}

async function probe(browser: Browser, entity: UlineEntity, headed: boolean): Promise<ProbeResult> {
  const { user, pass } = creds(entity);
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  const shot = (name: string): Promise<unknown> =>
    page.screenshot({ path: join(SHOT_DIR, `uline-${entity}-${name}.png`), fullPage: false }).catch(() => null);
  try {
    await page.goto('https://www.uline.com/SignIn/SignIn', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500); // let Akamai sensor settle before touching the form
    const preSignals = await pageSignals(page);
    if (preSignals.blocked || preSignals.challenge) {
      await shot('pre-block');
      return {
        entity,
        verdict: preSignals.challenge ? 'CHALLENGE' : 'BOT_BLOCKED',
        finalUrl: page.url(),
        detail: `blocked before login: ${preSignals.detail}`,
        orderHistoryLoads: false,
      };
    }
    await page.fill('#txtEmail', user);
    await page.fill('input[type="password"]', pass);
    await shot('filled');
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => null),
      page.getByRole('button', { name: /sign in/i }).first().click(),
    ]);
    await page.waitForTimeout(4000); // post-login redirects / client-side validation
    let url = page.url();
    let post = await pageSignals(page);
    await shot('post-login');
    if (post.blocked) return { entity, verdict: 'BOT_BLOCKED', finalUrl: url, detail: post.detail, orderHistoryLoads: false };
    // Challenge detection must look across frames — reCAPTCHA lives in an iframe.
    const hasChallenge = async (): Promise<boolean> => {
      for (const f of page.frames()) {
        const t = await f.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        if (/not a robot|quick test to confirm/i.test(t)) return true;
      }
      return false;
    };
    const stillOnSignIn = (): boolean => /signin/i.test(page.url());
    if (headed && (stillOnSignIn() || (await hasChallenge()))) {
      // Bootstrap mode: the human completes login in the window (captcha, re-submit, whatever
      // ULINE asks). We just poll until the URL leaves the sign-in flow, up to 5 minutes.
      console.error(`  ${entity}: complete the login in the browser window (solve the captcha, click Sign In again if needed).`);
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline && stillOnSignIn()) {
        await page.waitForTimeout(3000);
      }
      await page.waitForTimeout(3000);
      url = page.url();
      post = await pageSignals(page);
      await shot('post-captcha');
      if (stillOnSignIn()) {
        return { entity, verdict: 'CHALLENGE', finalUrl: url, detail: 'login never completed in headed window (timeout)', orderHistoryLoads: false };
      }
    } else if (await hasChallenge()) {
      return { entity, verdict: 'CHALLENGE', finalUrl: url, detail: 'reCAPTCHA interstitial on scripted login (headless)', orderHistoryLoads: false };
    }
    if (post.badCreds) return { entity, verdict: 'BAD_CREDENTIALS', finalUrl: url, detail: post.detail, orderHistoryLoads: false };

    // The real test: does an authenticated page load?
    await page.goto('https://www.uline.com/MyAccount/MyOrderHistory', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    const ohUrl = page.url();
    const oh = await pageSignals(page);
    const orderHistoryLoads = /MyOrderHistory/i.test(ohUrl) && !/SignIn/i.test(ohUrl) && !oh.blocked;
    await shot('order-history');
    if (orderHistoryLoads) {
      mkdirSync(STATE_DIR, { recursive: true });
      await context.storageState({ path: join(STATE_DIR, `uline-${entity}.json`) });
    }
    return {
      entity,
      verdict: orderHistoryLoads ? 'LOGIN_OK' : oh.blocked ? 'BOT_BLOCKED' : 'ERROR',
      finalUrl: ohUrl,
      detail: orderHistoryLoads ? `order history loaded (headed=${headed})` : oh.detail,
      orderHistoryLoads,
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
    console.error(`Probing ULINE ${entity} (${headed ? 'headed' : 'headless'})...`);
    results.push(await probe(browser, entity, headed));
  }
  await browser.close();
  console.log('\n================ ULINE SCRIPTED-LOGIN PROBE ================');
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
