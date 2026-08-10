// DUMMY RUN (cred-less): does b2b.toprx.com show bot screening to a headless browser?
// Loads the login page, fingerprints bot-defense stacks, confirms the form renders.
// Run from web/ dir:  npx tsx scripts/receipt-enrichment/engines/receipt-capture/toprx-screener-probe.ts
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { RC } from '../../paths';

// Consolidated cache, not next to this module — see toprx-login-probe.ts.
const SHOT_DIR = RC.probeShots;

interface Fingerprint {
  finalUrl: string;
  title: string;
  loginFormRenders: boolean;
  recaptcha: boolean;
  hcaptcha: boolean;
  turnstileOrCf: boolean;
  akamai: boolean;
  perimeterx: boolean;
  datadome: boolean;
  blockedText: boolean;
  cookieNames: string[];
  scriptHosts: string[];
}

async function main(): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://b2b.toprx.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);
  const cookies = await context.cookies();
  const cookieNames = cookies.map((c) => c.name);
  // NOTE: evaluate body passed as a string — tsx/esbuild injects a __name helper into
  // transformed closures that doesn't exist inside the page context.
  const evalBody = `((names) => {
    const hasSel = (s) => !!document.querySelector(s);
    const scripts = Array.from(document.scripts).map((x) => x.src).filter(Boolean);
    const body = document.body ? document.body.innerText : '';
    return {
      finalUrl: location.href,
      title: document.title,
      loginFormRenders: hasSel('input[type="password"]'),
      recaptcha: hasSel('.g-recaptcha, iframe[src*="recaptcha"]') || scripts.some((s) => s.includes('recaptcha')),
      hcaptcha: hasSel('iframe[src*="hcaptcha"]') || scripts.some((s) => s.includes('hcaptcha')),
      turnstileOrCf: hasSel('iframe[src*="turnstile"], #challenge-form') || names.some((c) => c === 'cf_clearance' || c.indexOf('__cf') === 0),
      akamai: names.some((c) => ['_abck', 'ak_bmsc', 'bm_sz', 'bm_sv', 'bm_mi'].indexOf(c) >= 0),
      perimeterx: names.some((c) => c.indexOf('_px') === 0) || scripts.some((s) => /px-cloud|perimeterx/i.test(s)),
      datadome: names.indexOf('datadome') >= 0 || scripts.some((s) => /datadome/i.test(s)),
      blockedText: /access denied|not a robot|verify you are|unusual traffic|reference #\\d/i.test(body),
      cookieNames: names.slice(0, 25),
      scriptHosts: [...new Set(scripts.map((s) => { try { return new URL(s).host; } catch { return s; } }))].slice(0, 15),
    };
  })(${JSON.stringify(cookieNames)})`;
  const fp: Fingerprint = await page.evaluate(evalBody) as Fingerprint;
  await page.screenshot({ path: join(SHOT_DIR, 'toprx-login.png') });
  console.log(JSON.stringify(fp, null, 2));
  await browser.close();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
