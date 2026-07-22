// Switch the one authenticated Amazon Business login between its member businesses (FL/TN/TX) via the
// account picker, so a single signed-in session can export every location. Validated live 2026-07-22:
// the picker lists each business as an <a data-name="switch_account_request"> whose visible text
// contains the business's customerName (e.g. "MedRock Tennessee"); clicking it POSTs /ap/switchaccount
// and lands on that business's dashboard.
import type { Page } from '@playwright/test';

export const PICKER_URL =
  'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fb2b%2Faba%2Fdashboard%2F%3Fref%3Dnav_youraccount_switchacct&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&switch_account=picker&ignoreAuthState=1&_encoding=UTF8';

// Standard --account label -> the business's customerName shown in the switcher.
export const BUSINESS_BY_ACCOUNT: Record<string, string> = {
  FL: 'MedRock Florida',
  TN: 'MedRock Tennessee',
  TX: 'MedRock Texas',
};

// The businessName sub-label (kept for reference; matching uses customerName which is unambiguous):
//   FL -> "MedRock Pharmacy", TN -> "Medrock Pharmacy, LLC", TX -> "MedRock Texas".

// Open the picker and wait for the switch tiles to render (they appear ~1-2s after domcontentloaded).
async function openPicker(page: Page): Promise<void> {
  await page.goto(PICKER_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('a[data-name="switch_account_request"]').first().waitFor({ state: 'attached', timeout: 20_000 });
}

// Return the customerName labels the switcher currently offers (for diagnostics / validation).
export async function listBusinesses(page: Page): Promise<string[]> {
  await openPicker(page);
  return page.locator('a[data-name="switch_account_request"] [data-test-id="customerName"]')
    .allTextContents()
    .then((xs) => xs.map((s) => s.trim()).filter(Boolean));
}

// Switch the active business to the one whose customerName contains `targetName`. Throws if not offered.
export async function switchToBusiness(page: Page, targetName: string): Promise<void> {
  await openPicker(page);
  const link = page.locator('a[data-name="switch_account_request"]').filter({ hasText: targetName }).first();
  if (!(await link.count())) {
    const available = await page.locator('a[data-name="switch_account_request"] [data-test-id="customerName"]').allTextContents();
    throw new Error(`Business "${targetName}" not found in the account switcher. Available: ${available.map((s) => s.trim()).join(', ')}`);
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => undefined),
    link.click(),
  ]);
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
}
