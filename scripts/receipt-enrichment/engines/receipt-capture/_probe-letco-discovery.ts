// Discovery probe for the Fagron Shop portal (Letco). READ-ONLY: logs in, loads the invoice
// roster, records every XHR the page makes, and inspects one invoice detail page for the document
// link. Writes nothing to Ramp, QuickBooks or the portal.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-letco-discovery.ts [FL|TN|TX]
import '../ramp-split-push/load-env';
import { chromium } from 'playwright';
import type { Page, Response } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { Entity } from '../ramp-split-push/types';
import { RC } from '../../paths';

const ENTITY = (process.argv[2] ?? 'FL') as Entity;
const BASE = 'https://shop.fagron.us';
const OUT = `${RC.out}/letco-discovery`;

interface Captured {
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  bodyHead: string;
}

function creds(entity: Entity): { user: string; pass: string } {
  const user = process.env[`LETCO_${entity}`];
  const pass = process.env[`LETCO_${entity}_Pass`];
  if (!user || !pass) throw new Error(`Missing LETCO_${entity} / LETCO_${entity}_Pass in web/.env.local`);
  return { user, pass };
}

async function login(page: Page, entity: Entity): Promise<void> {
  const { user, pass } = creds(entity);
  await page.goto(`${BASE}/profile/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(1200);
  await page.fill('input[name="UserName"]', user);
  await page.fill('input[name="Password"]', pass);
  const remember = page.locator('input[name="RememberMe"]').first();
  if (await remember.isVisible().catch(() => false)) await remember.check().catch(() => null);
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => null),
    page.locator('button[type="submit"], input[type="submit"]').first().click(),
  ]);
  await page.waitForTimeout(3000);
  if (/\/profile\/login/i.test(page.url())) {
    throw new Error(`Letco ${entity}: login did not stick — still on ${page.url()}`);
  }
  console.log(`  logged in, landed on ${page.url()}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const captured: Captured[] = [];
  page.on('response', (res: Response) => {
    const ct = res.headers()['content-type'] ?? '';
    if (!/json|pdf|octet-stream/i.test(ct)) return;
    void res
      .body()
      .then((buf) => {
        captured.push({
          url: res.url(),
          status: res.status(),
          contentType: ct,
          bytes: buf.length,
          bodyHead: /json/i.test(ct) ? buf.toString('utf8').slice(0, 1200) : `<binary ${buf.length} bytes>`,
        });
      })
      .catch(() => undefined);
  });

  try {
    console.log(`=== ${ENTITY}: login ===`);
    await login(page, ENTITY);

    console.log('\n=== invoice roster ===');
    await page.goto(`${BASE}/profile/orders/?OrderType=Invoice`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(5000);

    const rowCount = await page.evaluate(() => document.querySelectorAll('table.gvi-orders tbody tr').length);
    console.log(`  rendered rows in the grid: ${rowCount}`);

    const firstRows: string[][] = await page.evaluate(() =>
      [...document.querySelectorAll('table.gvi-orders tbody tr')].slice(0, 5).map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim()),
      ),
    );
    console.log('  first rows:');
    for (const r of firstRows) console.log('    ', r.filter((c) => c !== '').join(' | ').slice(0, 160));

    console.log('\n=== XHRs captured on the roster page ===');
    for (const c of captured) {
      console.log(`  [${c.status}] ${c.contentType.split(';')[0]}  ${c.bytes}B  ${c.url.slice(0, 150)}`);
    }

    // The most promising JSON payload is the biggest one — dump it in full for shape analysis.
    const jsons = captured.filter((c) => /json/i.test(c.contentType)).sort((a, b) => b.bytes - a.bytes);
    if (jsons.length > 0) {
      writeFileSync(`${OUT}/roster-xhr.json`, JSON.stringify(jsons, null, 2));
      console.log(`\n  largest JSON payload (${jsons[0].bytes}B) from ${jsons[0].url}`);
      console.log(`  head: ${jsons[0].bodyHead.slice(0, 700)}`);
    } else {
      console.log('\n  NO JSON XHR captured — the grid may be server-rendered or bootstrapped inline.');
    }

    // Look at one invoice detail page for the document/PDF path.
    const firstDetail = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a[href*="orders/details"]')][0];
      return a instanceof HTMLAnchorElement ? a.href : null;
    });
    console.log(`\n=== invoice detail ===`);
    if (firstDetail === null) {
      console.log('  no /orders/details link found in the roster DOM');
    } else {
      console.log(`  opening ${firstDetail}`);
      await page.goto(firstDetail, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(4000);
      const links: string[] = await page.evaluate(() =>
        [...document.querySelectorAll('a[href], button[data-url]')]
          .map((el) => (el instanceof HTMLAnchorElement ? el.href : el.getAttribute('data-url') ?? ''))
          .filter((h) => /pdf|document|download|invoice|print/i.test(h)),
      );
      console.log(`  document-ish links: ${links.length === 0 ? '(none)' : ''}`);
      for (const l of [...new Set(links)].slice(0, 12)) console.log(`    ${l.slice(0, 160)}`);

      const headers = await page.evaluate(() =>
        [...document.querySelectorAll('th, .lbl, dt')].map((e) => (e.textContent ?? '').trim()).filter((t) => t !== '').slice(0, 25),
      );
      console.log(`  detail labels: ${headers.join(' | ').slice(0, 300)}`);
      writeFileSync(`${OUT}/detail.html`, await page.content());
      console.log(`  saved detail HTML -> ${OUT}/detail.html`);
    }

    writeFileSync(`${OUT}/all-xhr.json`, JSON.stringify(captured, null, 2));
    console.log(`\nsaved ${captured.length} captured responses -> ${OUT}/all-xhr.json`);
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
