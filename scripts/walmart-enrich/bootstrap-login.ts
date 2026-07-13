// One-time interactive Walmart login. Opens a real browser; you log in (and complete any OTP) BY HAND,
// then press Enter here to save the session. Re-run whenever the session expires.
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { chromium } from '@playwright/test';
import { SESSION_DIR, STATE_PATH } from './session';

async function main(): Promise<void> {
  mkdirSync(SESSION_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('https://www.walmart.com/account/login', { waitUntil: 'domcontentloaded' });
  console.log('\nLog in to Walmart in the opened window (complete any OTP). When you can see your');
  console.log('account/orders, come back here and press Enter to save the session...');
  await new Promise<void>((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); res(); });
  });
  await context.storageState({ path: STATE_PATH });
  console.log(`Saved session -> ${STATE_PATH}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
