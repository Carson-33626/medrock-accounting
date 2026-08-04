// Discovery: drive the Sana Commerce order-history JSON API over plain HTTP.
// The grid POSTs to the PAGE URL itself with {page, OrderId, DocumentId, OrderType, StartDate,
// EndDate} and receives {Items, TotalCount} (found in /content/script/shop). READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-letco-roster.ts [FL|TN|TX]
import '../ramp-split-push/load-env';
import { writeFileSync, mkdirSync } from 'node:fs';
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
function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

interface RosterItem {
  Id?: string;
  OrderId?: string;
  DocumentId?: string;
  DocumentDate?: string;
  DueDate?: string;
  OrderType?: string;
  TotalAmount?: string;
  OutstandingAmount?: string;
  OrderStatus?: string;
  Url?: string;
  IsOverdue?: boolean;
  PaymentStatus?: string;
}
interface RosterPage { Items?: RosterItem[]; TotalCount?: number }

async function login(entity: Entity): Promise<void> {
  const user = process.env[`LETCO_${entity}`];
  const pass = process.env[`LETCO_${entity}_Pass`];
  if (!user || !pass) throw new Error(`Missing LETCO_${entity} / LETCO_${entity}_Pass`);

  const page = await fetch(`${BASE}/profile/login`, { headers: { 'User-Agent': UA } });
  absorb(page);
  const html = await page.text();
  const token = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html);

  const form = new URLSearchParams({ UserName: user, Password: pass, RememberMe: 'true' });
  if (token !== null) form.set('__RequestVerificationToken', token[1]);

  const res = await fetch(`${BASE}/profile/login`, {
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
  absorb(res);
  if (!jar.has('.ASPXAUTH_SS')) throw new Error(`login failed for ${entity} (no auth cookie, HTTP ${res.status})`);
  console.log(`  [${entity}] authenticated`);
}

async function fetchPage(pageNo: number, startDate: string): Promise<RosterPage> {
  const url = `${BASE}/profile/orders/?OrderType=Invoice`;
  const body = new URLSearchParams({
    page: String(pageNo),
    OrderType: 'Invoice',
    StartDate: startDate,
    EndDate: '',
    OrderId: '',
    DocumentId: '',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: cookieHeader(),
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Origin: BASE,
      Referer: url,
    },
    body: body.toString(),
  });
  absorb(res);
  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (!/json/i.test(ct)) {
    console.log(`  page ${pageNo}: NOT JSON (${ct.split(';')[0]}, ${text.length}B)`);
    return {};
  }
  return JSON.parse(text) as RosterPage;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  console.log(`=== ${ENTITY} ===`);
  await login(ENTITY);

  const all: RosterItem[] = [];
  let total = 0;
  for (let p = 0; p < 12; p++) {
    const res = await fetchPage(p, '2026-05-01');
    const items = res.Items ?? [];
    total = res.TotalCount ?? total;
    console.log(`  page ${p}: ${items.length} items (TotalCount=${res.TotalCount ?? '?'})`);
    if (items.length === 0) break;
    all.push(...items);
    if (all.length >= total) break;
  }

  console.log(`\ncollected ${all.length} of ${total} invoices`);
  if (all.length > 0) {
    console.log('\n=== first 5 ===');
    for (const it of all.slice(0, 5)) {
      console.log(
        `  doc=${it.DocumentId ?? '-'}  order=${it.OrderId ?? '-'}  date=${it.DocumentDate ?? '-'}  due=${it.DueDate ?? '-'}  total=${it.TotalAmount ?? '-'}  outst=${it.OutstandingAmount ?? '-'}  status=${it.OrderStatus ?? '-'}`,
      );
      console.log(`      url=${it.Url ?? '-'}`);
    }
    console.log('\n=== all keys on item[0] ===');
    console.log('  ' + Object.keys(all[0]).join(', '));
    writeFileSync(`${OUT}/roster-${ENTITY}.json`, JSON.stringify(all, null, 2));
    console.log(`\nsaved -> ${OUT}/roster-${ENTITY}.json`);
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
