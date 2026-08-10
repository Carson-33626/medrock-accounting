// Discovery: what does a Letco invoice DETAIL page give us — line items, shipping, and a
// downloadable document for the Ramp bill attachment? READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-letco-detail.ts [FL|TN|TX]
import '../ramp-split-push/load-env';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import type { Entity } from '../ramp-split-push/types';
import { RC } from '../../paths';

const ENTITY = (process.argv[2] ?? 'FL') as Entity;
const BASE = 'https://shop.fagron.us';
const OUT = `${RC.out}/letco-discovery`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const jar = new Map<string, string>();
function absorb(res: Response): void {
  const raw: string[] = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const first = line.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}
const cookieHeader = (): string => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function login(entity: Entity): Promise<void> {
  const user = process.env[`LETCO_${entity}`];
  const pass = process.env[`LETCO_${entity}_Pass`];
  if (!user || !pass) throw new Error(`Missing LETCO_${entity} creds`);
  const page = await fetch(`${BASE}/profile/login`, { headers: { 'User-Agent': UA } });
  absorb(page);
  const token = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(await page.text());
  const form = new URLSearchParams({ UserName: user, Password: pass, RememberMe: 'true' });
  if (token !== null) form.set('__RequestVerificationToken', token[1]);
  const res = await fetch(`${BASE}/profile/login`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Cookie: cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, Referer: `${BASE}/profile/login` },
    body: form.toString(),
    redirect: 'manual',
  });
  absorb(res);
  if (!jar.has('.ASPXAUTH_SS')) throw new Error('login failed');
  console.log(`  [${entity}] authenticated`);
}

interface RosterItem { DocumentId?: string; Url?: string; TotalAmount?: string; DocumentDate?: string }

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await login(ENTITY);

  const rosterPath = `${OUT}/roster-${ENTITY}.json`;
  if (!existsSync(rosterPath)) throw new Error(`run _probe-letco-roster.ts ${ENTITY} first`);
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8')) as RosterItem[];
  const first = roster[0];
  console.log(`\n=== detail for ${first.DocumentId} (total ${first.TotalAmount}) ===`);

  const res = await fetch(`${BASE}${first.Url ?? ''}`, {
    headers: { 'User-Agent': UA, Cookie: cookieHeader(), Accept: 'text/html,*/*' },
  });
  absorb(res);
  const html = await res.text();
  console.log(`  HTTP ${res.status}  ${html.length} bytes`);
  writeFileSync(`${OUT}/detail-${ENTITY}.html`, html);

  // Line-item table headers
  const ths = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t !== '');
  console.log(`\n  table headers: ${[...new Set(ths)].join(' | ').slice(0, 220)}`);

  // Rows
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()))
    .filter((r) => r.length > 1);
  console.log(`  data rows: ${rows.length}`);
  for (const r of rows.slice(0, 8)) console.log(`    ${r.filter((c) => c !== '').join(' | ').slice(0, 170)}`);

  // Totals / shipping labels
  const totals = [...html.matchAll(/<(?:dt|span|div|td)[^>]*class="[^"]*(?:total|shipping|freight|tax|summary)[^"]*"[^>]*>([\s\S]{0,120}?)</gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t !== '');
  console.log(`\n  total/shipping-ish text: ${[...new Set(totals)].slice(0, 12).join(' | ').slice(0, 300)}`);

  // Document download candidates
  const links = [...new Set([...html.matchAll(/(?:href|data-url)="([^"]+)"/g)].map((m) => m[1]))]
    .filter((h) => /pdf|document|download|print|attachment/i.test(h));
  console.log(`\n  document links (${links.length}):`);
  for (const l of links.slice(0, 12)) console.log(`    ${l.slice(0, 170)}`);

  // If a document link exists, try fetching it and check for %PDF
  if (links.length > 0) {
    const target = links[0].startsWith('http') ? links[0] : `${BASE}${links[0]}`;
    const doc = await fetch(target, { headers: { 'User-Agent': UA, Cookie: cookieHeader() } });
    const buf = Buffer.from(await doc.arrayBuffer());
    console.log(`\n  fetched ${target.slice(0, 120)}`);
    console.log(`    HTTP ${doc.status}  ${doc.headers.get('content-type')}  ${buf.length}B  %PDF=${buf.subarray(0, 4).toString('latin1') === '%PDF'}`);
    if (buf.subarray(0, 4).toString('latin1') === '%PDF') writeFileSync(`${OUT}/invoice-${ENTITY}.pdf`, buf);
  }
  console.log(`\n  saved detail HTML -> ${OUT}/detail-${ENTITY}.html`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
