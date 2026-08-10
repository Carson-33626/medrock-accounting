// Diagnostic: is shop.fagron.us reachable at all, and is the failure HTTP/2-specific or
// headless-specific? Three independent probes, no login, no writes.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-letco-reach.ts
import '../ramp-split-push/load-env';
import { chromium } from 'playwright';

const URL_LOGIN = 'https://shop.fagron.us/profile/login';

async function viaFetch(): Promise<void> {
  console.log('=== 1. plain node fetch (undici, HTTP/1.1) ===');
  try {
    const res = await fetch(URL_LOGIN, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    const body = await res.text();
    console.log(`  HTTP ${res.status} ${res.statusText}  ${body.length} bytes`);
    console.log(`  server: ${res.headers.get('server') ?? '-'}  cf-ray: ${res.headers.get('cf-ray') ?? '-'}`);
    console.log(`  has UserName field: ${/name="UserName"/.test(body)}`);
  } catch (e: unknown) {
    console.log(`  FAILED: ${(e as Error).message}`);
  }
}

async function viaChromium(label: string, args: string[], headless: boolean): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const browser = await chromium.launch({ headless, args });
  try {
    const page = await browser.newPage();
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const has = await page.evaluate(() => document.querySelector('input[name="UserName"]') !== null);
    console.log(`  OK — landed on ${page.url()}, UserName field present: ${has}`);
  } catch (e: unknown) {
    console.log(`  FAILED: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  await viaFetch();
  await viaChromium('2. headless chromium, default', [], true);
  await viaChromium('3. headless chromium, --disable-http2', ['--disable-http2'], true);
  await viaChromium('4. HEADED chromium, default', [], false);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
