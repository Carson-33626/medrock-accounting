// Probe: log into the Medisca portal via its NextAuth credentials provider and see how far we can
// reach without a browser. Read-only — nothing is ordered, changed or downloaded to the account.
//
// The portal is Next.js + NextAuth, so the login is the standard three-step credentials dance:
//   GET  /api/auth/csrf                   -> csrfToken + __Host-next-auth.csrf-token cookie
//   POST /api/auth/callback/credentials   -> __Secure-next-auth.session-token cookie
//   GET  /dashboard/...                   -> server-rendered HTML, with that cookie
//
//   npx tsx scripts/receipt-capture/_probe-medisca-login.ts [FL|TN|TX]
import '../ramp-split-push/load-env';

const BASE = 'https://www.medisca.com';
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
  has(name: string): boolean { return this.jar.has(name); }
  names(): string[] { return [...this.jar.keys()]; }
}

async function main(): Promise<void> {
  const entity = (process.argv[2] ?? 'FL').toUpperCase();
  const user = (process.env[`MEDISCA_${entity}`] ?? '').trim();
  const pass = (process.env[`MEDISCA_${entity}_Pass`] ?? '').trim();
  if (user === '' || pass === '') throw new Error(`Missing MEDISCA_${entity} / MEDISCA_${entity}_Pass`);
  console.log(`entity=${entity} user=${user.replace(/(.{2}).*(@.*)/, '$1***$2')}`);

  const jar = new Jar();

  // The shipped bundle calls signIn("credentials",{redirect:!1,email,password,locale}). `locale` is
  // NOT optional — omitting it is what produced the first round of 401 CredentialsSignin. The site
  // hands out its own default in the NEXT_LOCALE cookie, so take it from there rather than assuming.
  const home = await fetch(`${BASE}/login`, { headers: { 'User-Agent': UA } });
  jar.absorb(home);
  const rawLocale = (typeof home.headers.getSetCookie === 'function' ? home.headers.getSetCookie() : [])
    .find((c) => c.startsWith('NEXT_LOCALE='));
  const locale = rawLocale ? rawLocale.split(';')[0].split('=')[1] : 'en-US';
  console.log(`locale: ${locale}${rawLocale ? ' (from NEXT_LOCALE cookie)' : ' (fallback)'}`);

  const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { headers: { 'User-Agent': UA, Cookie: jar.header() } });
  jar.absorb(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  console.log(`csrf: HTTP ${csrfRes.status}, token len ${csrfToken.length}, cookies=[${jar.names().join(', ')}]`);

  const body = new URLSearchParams({
    csrfToken,
    email: user,
    password: pass,
    locale,
    callbackUrl: `${BASE}/dashboard`,
    json: 'true',
  });
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: jar.header(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: BASE,
      Referer: `${BASE}/login`,
    },
    body: body.toString(),
    redirect: 'manual',
  });
  jar.absorb(loginRes);
  const loginBody = await loginRes.text();
  console.log(`login: HTTP ${loginRes.status} -> ${loginRes.headers.get('location') ?? '(no redirect)'}`);
  console.log(`       body: ${loginBody.slice(0, 200)}`);
  console.log(`       cookies now: [${jar.names().join(', ')}]`);

  if (!jar.has(SESSION_COOKIE)) {
    console.log(`\nNO SESSION COOKIE — login did not succeed. (A NextAuth credentials failure still ` +
      `returns 200/302, so the cookie is the only honest signal.)`);
    return;
  }
  console.log(`\nLOGIN OK — ${SESSION_COOKIE} present\n`);

  const session = await fetch(`${BASE}/api/auth/session`, { headers: { 'User-Agent': UA, Cookie: jar.header() } });
  console.log(`session: HTTP ${session.status} ${(await session.text()).slice(0, 400)}`);

  for (const path of [
    '/dashboard/invoices/unpaid-invoices',
    '/dashboard/invoices/paid-invoices',
    '/dashboard/orders',
  ]) {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': UA, Cookie: jar.header() },
      redirect: 'manual',
    });
    const html = await res.text();
    console.log(`\n### ${path}`);
    console.log(`    HTTP ${res.status} ${res.headers.get('location') ?? ''} bytes=${html.length}`);
    // Invoice numbers are zero-padded 8-digit; order numbers share the shape but live under /orders/.
    const invoiceLinks = [...new Set([...html.matchAll(/\/dashboard\/invoices?\/[a-zA-Z0-9/_-]+/g)].map((m) => m[0]))];
    const numbers = [...new Set([...html.matchAll(/\b0\d{7}\b/g)].map((m) => m[0]))];
    const pdfish = [...new Set([...html.matchAll(/https?:\/\/[^"' ]*(pdf|invoice|document|file)[^"' ]*/gi)].map((m) => m[0]))];
    console.log(`    invoice-ish links (${invoiceLinks.length}): ${JSON.stringify(invoiceLinks.slice(0, 8))}`);
    console.log(`    8-digit numbers (${numbers.length}): ${JSON.stringify(numbers.slice(0, 12))}`);
    console.log(`    pdf/doc URLs (${pdfish.length}): ${JSON.stringify(pdfish.slice(0, 6))}`);
    const headers = [...new Set([...html.matchAll(/<th[^>]*>(?:<[^>]+>)*([^<]{2,30})</g)].map((m) => m[1].trim()))];
    console.log(`    table headers: ${JSON.stringify(headers.slice(0, 14))}`);
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
