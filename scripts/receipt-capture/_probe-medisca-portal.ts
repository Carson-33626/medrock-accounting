// Probe: how does the Medisca portal authenticate, and can we reach invoices without a browser?
//
// Read-only reconnaissance. Establishes, in order:
//   1. what /login serves and whether it is a plain form, a Next.js server action, or an API call
//   2. what an UNAUTHENTICATED dashboard request does (redirect? 401? empty shell?)
//   3. whether the invoice list is server-rendered HTML we can parse, or client-fetched JSON
//
// Credentials are never printed. Nothing is written anywhere.
//   npx tsx scripts/receipt-capture/_probe-medisca-portal.ts
import '../ramp-split-push/load-env';

const BASE = 'https://www.medisca.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

function setCookies(res: Response): string[] {
  return typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
}

function cookieNames(res: Response): string {
  return setCookies(res).map((c) => c.split('=')[0]).join(', ') || '(none)';
}

async function show(label: string, url: string, init?: RequestInit): Promise<{ status: number; body: string; res: Response }> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init?.headers ?? {}) },
    redirect: 'manual',
  });
  const body = await res.text();
  console.log(`\n### ${label}`);
  console.log(`    ${init?.method ?? 'GET'} ${url}`);
  console.log(`    HTTP ${res.status}  ${res.headers.get('content-type') ?? ''}`);
  const loc = res.headers.get('location');
  if (loc) console.log(`    -> Location: ${loc}`);
  console.log(`    set-cookie: ${cookieNames(res)}`);
  console.log(`    bytes: ${body.length}`);
  return { status: res.status, body, res };
}

function findAll(body: string, re: RegExp, cap = 12): string[] {
  return [...new Set([...body.matchAll(re)].map((m) => m[0]))].slice(0, cap);
}

async function main(): Promise<void> {
  const user = process.env.MEDISCA_FL;
  console.log(`MEDISCA_FL present: ${user !== undefined && user.trim() !== ''}`);
  console.log(`MEDISCA_FL_Pass present: ${(process.env.MEDISCA_FL_Pass ?? '').trim() !== ''}`);

  // 1. The login page itself.
  const login = await show('login page', `${BASE}/login`);
  console.log(`    <form action=>: ${JSON.stringify(findAll(login.body, /<form[^>]*action="[^"]*"/g, 6))}`);
  console.log(`    next-action ids: ${JSON.stringify(findAll(login.body, /next-action[^"]{0,60}/gi, 4))}`);
  console.log(`    input names: ${JSON.stringify(findAll(login.body, /<input[^>]*name="[^"]+"/g, 10))}`);
  console.log(`    captcha refs: hcaptcha=${(login.body.match(/hcaptcha/gi) ?? []).length} recaptcha=${(login.body.match(/recaptcha/gi) ?? []).length} turnstile=${(login.body.match(/turnstile/gi) ?? []).length}`);
  console.log(`    auth hints: ${JSON.stringify(findAll(login.body, /(signIn|next-auth|auth0|cognito|okta|msal|identity)[a-zA-Z/_-]{0,24}/gi, 12))}`);

  // Next.js server actions announce themselves in the RSC payload; a plain REST login would not.
  console.log(`    RSC flight payload present: ${login.body.includes('__next_f')}`);
  console.log(`    api routes referenced: ${JSON.stringify(findAll(login.body, /\/api\/[a-zA-Z0-9/_-]+/g, 15))}`);

  // 2. Unauthenticated dashboard — reveals the auth gate and the cookie it wants.
  for (const path of ['/dashboard/invoices/unpaid-invoices', '/dashboard/orders']) {
    const r = await show(`unauthenticated ${path}`, `${BASE}${path}`);
    console.log(`    looks like login redirect: ${r.status === 307 || r.status === 302 || /sign in|log in/i.test(r.body.slice(0, 4000))}`);
  }

  // 3. Is there a NextAuth endpoint? It is by far the most common auth layer on this stack, and it
  //    would mean a documented, scriptable credentials POST rather than a bespoke server action.
  const providers = await show('nextauth providers', `${BASE}/api/auth/providers`);
  if (providers.status === 200) console.log(`    ${providers.body.slice(0, 400)}`);
  const csrf = await show('nextauth csrf', `${BASE}/api/auth/csrf`);
  if (csrf.status === 200) console.log(`    ${csrf.body.slice(0, 200)}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
