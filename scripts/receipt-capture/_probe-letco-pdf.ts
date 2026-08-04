// Discovery: confirm the Letco invoice PDF endpoint returns real %PDF bytes over plain HTTP.
//   npx tsx scripts/receipt-capture/_probe-letco-pdf.ts [FL|TN|TX]
import '../ramp-split-push/load-env';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import type { Entity } from '../ramp-split-push/types';

const ENTITY = (process.argv[2] ?? 'FL') as Entity;
const BASE = 'https://shop.fagron.us';
const OUT = 'scripts/receipt-capture/out/letco-discovery';
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
}

interface RosterItem { DocumentId?: string; OrderId?: string; TotalAmount?: string }

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await login(ENTITY);
  const rosterPath = `${OUT}/roster-${ENTITY}.json`;
  if (!existsSync(rosterPath)) throw new Error(`run _probe-letco-roster.ts ${ENTITY} first`);
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8')) as RosterItem[];

  for (const it of roster.slice(0, 3)) {
    const doc = it.DocumentId ?? '';
    const ord = it.OrderId ?? '';
    const url = `${BASE}/orders/files/report.pdf?OrderId=Invoice_${doc}&OriginalOrderId=${ord}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookieHeader(), Accept: 'application/pdf,*/*' } });
    const buf = Buffer.from(await res.arrayBuffer());
    const isPdf = buf.subarray(0, 4).toString('latin1') === '%PDF';
    console.log(`${doc}  HTTP ${res.status}  ${res.headers.get('content-type')}  ${buf.length}B  %PDF=${isPdf}`);
    if (isPdf) {
      writeFileSync(`${OUT}/invoice-${doc}.pdf`, buf);
      console.log(`   saved -> ${OUT}/invoice-${doc}.pdf`);
    }
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
