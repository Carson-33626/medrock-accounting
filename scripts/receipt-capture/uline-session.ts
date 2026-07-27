// scripts/receipt-capture/uline-session.ts
//
// ULINE session provider — reuses a persisted, hand-logged-in storageState instead of attaching
// to a running Chrome over CDP (walmart-enrich bootstrap pattern, see
// scripts/walmart-enrich/session.ts). Bootstrap once per entity (headed, human does the ENTIRE
// login) via uline-bootstrap.ts; runs reuse the saved state headless. The CDP-attach adapter
// (uline-cdp.ts, withUlinePage) stays in the codebase as a fallback if storageState reuse ever
// gets blocked by Akamai/Riskified.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Entity } from '../ramp-split-push/types';

const STATE_DIR = join(__dirname, '.state');
const ORDER_HISTORY_URL = 'https://www.uline.com/MyAccount/MyOrderHistory';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function ulineStatePath(entity: Entity): string {
  return join(STATE_DIR, `uline-${entity}.json`);
}

export function ulineSessionExists(entity: Entity): boolean {
  return existsSync(ulineStatePath(entity));
}

/**
 * Run `fn` against an authenticated ULINE page loaded from a persisted storageState. Defaults to
 * headless (fast path); pass `{ headless: false }` to retry with a headed browser if Akamai
 * rejects the headless reuse of a headed-created session (challenge/redirect) — headed reuse is
 * an acceptable fallback, never scripted login.
 */
export async function withUlineContext<T>(
  entity: Entity,
  fn: (page: Page) => Promise<T>,
  opts: { headless?: boolean } = {},
): Promise<T> {
  const statePath = ulineStatePath(entity);
  if (!ulineSessionExists(entity)) {
    throw new Error(
      `No ULINE session for ${entity} at ${statePath}. Run: npx tsx scripts/receipt-capture/uline-bootstrap.ts --entity=${entity}`,
    );
  }
  const headless = opts.headless ?? true;
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({ storageState: statePath, userAgent: UA, viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(ORDER_HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (/signin/i.test(page.url())) {
        throw new Error(
          `ULINE_SIGNIN_REQUIRED: session expired — re-run npx tsx scripts/receipt-capture/uline-bootstrap.ts --entity=${entity}`,
        );
      }
      return await fn(page);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
