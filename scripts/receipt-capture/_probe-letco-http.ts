// Discovery: can the Fagron Shop portal be driven over plain HTTP with a cookie jar, no browser?
// Headless Chromium is rejected by the server (ERR_HTTP2_PROTOCOL_ERROR) but plain fetch gets 200,
// so an HTTP-only adapter would be far more robust than the browser pattern we use elsewhere.
// READ-ONLY: logs in and GETs pages. No writes anywhere.
//   npx tsx scripts/receipt-capture/_probe-letco-http.ts [FL|TN|TX]
import '../ramp-split-push/load-env';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { Entity } from '../ramp-split-push/types';

const ENTITY = (process.argv[2] ?? 'FL') as Entity;
const BASE = 'https://shop.fagron.us';
const OUT = 'scripts/receipt-capture/out/letco-discovery';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// Minimal cookie jar: name -> value. Enough for one host.
const jar = new Map<string, string>();

function absorb(res: Response): void {
  // undici exposes multiple Set-Cookie via getSetCookie()
  const raw: string[] = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const first = line.split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function get(url: string): Promise<{ status: number; body: string; ct: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Cookie: cookieHeader(), Accept: 'text/html,application/json,*/*' },
    redirect: 'follow',
  });
  absorb(res);
  return { status: res.status, body: await res.text(), ct: res.headers.get('content-type') ?? '' };
}

function creds(entity: Entity): { user: string; pass: string } {
  const user = process.env[`LETCO_${entity}`];
  const pass = process.env[`LETCO_${entity}_Pass`];
  if (!user || !pass) throw new Error(`Missing LETCO_${entity} / LETCO_${entity}_Pass in web/.env.local`);
  return { user, pass };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { user, pass } = creds(ENTITY);

  console.log('=== 1. GET login page (collect cookies) ===');
  const loginPage = await get(`${BASE}/profile/login`);
  console.log(`  HTTP ${loginPage.status}, cookies now: ${[...jar.keys()].join(', ') || '(none)'}`);
  const tokenMatch = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(loginPage.body);
  console.log(`  antiforgery token in form: ${tokenMatch === null ? 'no' : 'YES'}`);

  console.log('\n=== 2. POST credentials ===');
  const form = new URLSearchParams();
  form.set('UserName', user);
  form.set('Password', pass);
  form.set('RememberMe', 'true');
  if (tokenMatch !== null) form.set('__RequestVerificationToken', tokenMatch[1]);

  const loginRes = await fetch(`${BASE}/profile/login`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: cookieHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: BASE,
      Referer: `${BASE}/profile/login`,
    },
    body: form.toString(),
    redirect: 'manual',
  });
  absorb(loginRes);
  console.log(`  HTTP ${loginRes.status}  location: ${loginRes.headers.get('location') ?? '-'}`);
  console.log(`  cookies now: ${[...jar.keys()].join(', ')}`);

  console.log('\n=== 3. GET invoice roster ===');
  const roster = await get(`${BASE}/profile/orders/?OrderType=Invoice`);
  const authed = !/\/profile\/login/i.test(roster.body.slice(0, 4000)) && /orders/i.test(roster.body);
  console.log(`  HTTP ${roster.status}  ${roster.body.length} bytes  looks authenticated: ${authed}`);
  writeFileSync(`${OUT}/http-roster.html`, roster.body);

  // Is the row data inline (server-rendered / bootstrapped), or fetched separately?
  const inlineRows = (roster.body.match(/DocumentId/g) ?? []).length;
  console.log(`  "DocumentId" occurrences in HTML: ${inlineRows}`);
  const jsonBootstrap = /var\s+\w+\s*=\s*(\{[\s\S]{200,}?\});/.exec(roster.body);
  console.log(`  inline JSON bootstrap found: ${jsonBootstrap === null ? 'no' : `yes (${jsonBootstrap[1].length} chars)`}`);

  console.log('\n=== 4. probe likely JSON endpoints ===');
  const candidates = [
    '/profile/orders/GetOrders?OrderType=Invoice',
    '/profile/orders/getorders?OrderType=Invoice',
    '/profile/orders/list?OrderType=Invoice',
    '/api/orders?OrderType=Invoice',
    '/profile/orders/data?OrderType=Invoice',
  ];
  for (const path of candidates) {
    const r = await get(`${BASE}${path}`);
    const isJson = /json/i.test(r.ct);
    console.log(`  ${path.padEnd(46)} -> ${r.status} ${isJson ? 'JSON' : r.ct.split(';')[0]} ${r.body.length}B`);
    if (isJson && r.status === 200) {
      writeFileSync(`${OUT}/http-orders.json`, r.body);
      console.log(`     head: ${r.body.slice(0, 400)}`);
    }
  }

  console.log(`\nsaved roster HTML -> ${OUT}/http-roster.html`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
