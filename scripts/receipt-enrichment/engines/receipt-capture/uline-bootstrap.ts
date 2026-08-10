// One-time interactive ULINE login per entity account — walmart-enrich bootstrap pattern.
// Opens a HEADED browser at the ULINE sign-in page; the human does the ENTIRE login by hand
// (credentials, any captcha — nothing is automated). The script only watches for the session
// to become authenticated, then saves storageState for headless reuse and exits.
// Run from web/ dir:  npx tsx scripts/receipt-enrichment/engines/receipt-capture/uline-bootstrap.ts --entity=FL
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import type { Entity } from '../ramp-split-push/types';
import { RC, sessionPath } from '../../paths';

// See toprx-session.ts: sessions live in the consolidated cache, not next to this module. This
// file is what WRITES them, so a wrong path here bootstraps into a directory nothing reads.
const POLL_MS = 3000;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes to complete the login by hand

function entityArg(): Entity {
  const raw = process.argv.find((a) => a.startsWith('--entity='))?.split('=')[1];
  if (raw === 'FL' || raw === 'TN' || raw === 'TX') return raw;
  throw new Error('Usage: npx tsx engines/receipt-capture/uline-bootstrap.ts --entity=FL|TN|TX');
}

async function main(): Promise<void> {
  const entity = entityArg();
  mkdirSync(RC.state, { recursive: true });
  const statePath = sessionPath('uline', entity);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('https://www.uline.com/SignIn/SignIn', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log(`\n=== ULINE ${entity} bootstrap ===`);
  console.log('Log in BY HAND in the opened window (email, password, any captcha).');
  console.log('The script watches for the login to complete — no keypress needed here.');
  console.log(`Waiting up to ${TIMEOUT_MS / 60000} minutes...\n`);

  const deadline = Date.now() + TIMEOUT_MS;
  let confirmedName: string | null = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);
    let url = '';
    try {
      url = page.url();
    } catch {
      throw new Error('Browser window was closed before the session could be saved — re-run the bootstrap.');
    }
    if (/signin/i.test(url)) continue; // still on the login flow — keep waiting
    // Left the sign-in flow: give redirects a moment, then positively confirm auth.
    await page.waitForTimeout(2000);
    try {
      await page.goto('https://www.uline.com/MyAccount/MyOrderHistory', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      if (/signin/i.test(page.url())) continue; // bounced back — not authenticated yet
      const name = await page.locator('#CompanyName').first().textContent({ timeout: 10000 }).catch(() => null);
      if (name && name.trim() !== '') {
        confirmedName = name.trim();
        break;
      }
    } catch {
      // navigation hiccup — keep polling until the deadline
    }
  }
  if (confirmedName === null) {
    await browser.close();
    throw new Error('Timed out (or never reached an authenticated Order History) — session NOT saved. Re-run the bootstrap.');
  }
  await context.storageState({ path: statePath });
  console.log(`Authenticated as: ${confirmedName}`);
  console.log(`Saved session -> ${statePath}`);
  await browser.close();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
