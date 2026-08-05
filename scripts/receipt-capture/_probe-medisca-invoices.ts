// Probe: close the remaining unknowns for Medisca CREATE mode.
//   1. does the locale-fixed login work for all THREE entities?
//   2. what customer_code / company does each session carry (the PDF URL is built from them)?
//   3. is the unpaid-invoice list parseable, and does it paginate?
//   4. does files.medisca.com/viewfile serve a real PDF, and does our parser read line items out?
//
// Read-only. Nothing is paid, ordered or written.
//   npx tsx scripts/receipt-capture/_probe-medisca-invoices.ts
import '../ramp-split-push/load-env';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

const BASE = 'https://www.medisca.com';
const FILES = 'https://files.medisca.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const SESSION_COOKIE = '__Secure-next-auth.session-token';

class Jar {
  private readonly jar = new Map<string, string>();
  absorb(res: Response): void {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header(): string { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  has(n: string): boolean { return this.jar.has(n); }
}

interface SessionInfo {
  user?: { email?: string; user_roles?: { customer_code?: string; medisca_site?: string }[] };
}

async function login(entity: Entity): Promise<{ jar: Jar; customer: string; company: string } | null> {
  const user = (process.env[`MEDISCA_${entity}`] ?? '').trim();
  const pass = (process.env[`MEDISCA_${entity}_Pass`] ?? '').trim();
  if (user === '' || pass === '') { console.log(`[${entity}] no credentials in .env.local`); return null; }

  const jar = new Jar();
  const home = await fetch(`${BASE}/login`, { headers: { 'User-Agent': UA } });
  jar.absorb(home);
  const rawLocale = (typeof home.headers.getSetCookie === 'function' ? home.headers.getSetCookie() : [])
    .find((c) => c.startsWith('NEXT_LOCALE='));
  const locale = rawLocale ? rawLocale.split(';')[0].split('=')[1] : 'en-US';

  const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { headers: { 'User-Agent': UA, Cookie: jar.header() } });
  jar.absorb(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'User-Agent': UA, Cookie: jar.header(),
      'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, Referer: `${BASE}/login`,
    },
    body: new URLSearchParams({ csrfToken, email: user, password: pass, locale, callbackUrl: `${BASE}/dashboard`, json: 'true' }).toString(),
    redirect: 'manual',
  });
  jar.absorb(res);
  if (!jar.has(SESSION_COOKIE)) { console.log(`[${entity}] LOGIN FAILED (HTTP ${res.status})`); return null; }

  const s = await fetch(`${BASE}/api/auth/session`, { headers: { 'User-Agent': UA, Cookie: jar.header() } });
  const info = (await s.json()) as SessionInfo;
  const role = info.user?.user_roles?.[0];
  const customer = role?.customer_code ?? '';
  const company = role?.medisca_site ?? '';
  console.log(`[${entity}] LOGIN OK  customer=${customer} company=${company} email=${info.user?.email ?? ''}`);
  return { jar, customer, company };
}

/** Rows are a plain server-rendered <table>; pull the cells in document order. */
function parseInvoiceRows(html: string): { invoice: string; order: string; cells: string[] }[] {
  const rows: { invoice: string; order: string; cells: string[] }[] = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 4) continue;
    const nums = cells.filter((c) => /^0\d{7}$/.test(c));
    if (nums.length === 0) continue;
    rows.push({ invoice: nums[0], order: nums[1] ?? '', cells });
  }
  return rows;
}

async function main(): Promise<void> {
  for (const entity of ALL_ENTITIES) {
    const sess = await login(entity);
    if (!sess) continue;

    const res = await fetch(`${BASE}/dashboard/invoices/unpaid-invoices`, {
      headers: { 'User-Agent': UA, Cookie: sess.jar.header() },
    });
    const html = await res.text();
    const rows = parseInvoiceRows(html);
    console.log(`[${entity}] unpaid list: HTTP ${res.status}, ${rows.length} row(s) parsed`);
    for (const r of rows.slice(0, 4)) console.log(`    ${r.invoice} order=${r.order} | ${r.cells.slice(1, 8).join(' | ')}`);

    // Pagination: how many pages does the UI advertise?
    const pageNums = [...new Set([...html.matchAll(/aria-label="(?:Go to )?page (\d+)"/gi)].map((m) => m[1]))];
    const nextish = /aria-label="(Go to next page|next)"/i.test(html);
    console.log(`    pagination: pages advertised ${JSON.stringify(pageNums.slice(0, 10))}, next control present=${nextish}`);

    if (rows.length === 0) continue;

    // The PDF URL is fully deterministic: customer code + company + 15-digit zero-padded invoice.
    const inv = rows[0].invoice;
    const url = `${FILES}/viewfile?Source=Website&Customer=${sess.customer}&Company=${sess.company}&Invoice=${inv.padStart(15, '0')}&Language=en`;
    for (const withCookie of [false, true]) {
      const pdf = await fetch(url, {
        headers: withCookie
          ? { 'User-Agent': UA, Cookie: sess.jar.header(), Referer: BASE }
          : { 'User-Agent': UA },
      });
      const buf = Buffer.from(await pdf.arrayBuffer());
      const magic = buf.subarray(0, 4).toString('latin1');
      console.log(`    PDF ${inv} ${withCookie ? 'WITH' : 'without'} session: HTTP ${pdf.status} ${buf.length}b magic=${JSON.stringify(magic)}`);
      if (magic === '%PDF' && withCookie) {
        const text = (await pdfParse(buf)).text;
        const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
        const totalIdx = lines.findIndex((l) => /SUB-TOTAL/i.test(l));
        console.log(`      parsed ${text.length} chars; invoice-no on page=${/\b${inv}\b/.test(text) ? 'yes' : 'n/a'}`);
        console.log(`      totals block: ${lines.slice(totalIdx, totalIdx + 3).join(' // ').slice(0, 160)}`);
      }
    }
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
