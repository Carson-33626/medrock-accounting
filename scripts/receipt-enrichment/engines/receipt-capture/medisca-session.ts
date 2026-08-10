// Authenticated HTTP session for the Medisca portal (Next.js + NextAuth credentials provider).
//
// NO BROWSER and no captcha. The single `hcaptcha` string in the captured login page turned out to
// live inside a Dark Reader browser-extension stylesheet, not the form.
//
// THE TRAP: the shipped bundle calls
//     signIn("credentials",{redirect:!1,email,password,locale})
// `locale` is REQUIRED. Omitting it returns HTTP 401 CredentialsSignin, which is indistinguishable
// from a wrong password — two entities were misdiagnosed as bad credentials before the field list
// was read out of _next/static/chunks/5511-*.js. The site hands out its own default in the
// NEXT_LOCALE cookie, so take it from there rather than hardcoding "en-US".
import type { Entity } from '../ramp-split-push/types';

const BASE = 'https://www.medisca.com';
const FILES = 'https://files.medisca.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const SESSION_COOKIE = '__Secure-next-auth.session-token';

// Each portal login is bound to one pharmacy. Asserting this stops a swapped credential in
// .env.local from silently booking FL invoices as TX bills — silent, and expensive to unwind.
export const EXPECTED_CUSTOMER_CODE: Record<Entity, string> = {
  FL: 'MEDPHA34N',
  TN: 'MEDR37N',
  TX: 'MEDRTX76N',
};

class CookieJar {
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
  value(name: string): string | undefined { return this.jar.get(name); }
}

interface SessionPayload {
  user?: {
    email?: string;
    user_roles?: { customer_code?: string; medisca_site?: string }[];
  };
}

export class MediscaSession {
  private constructor(
    private readonly jar: CookieJar,
    readonly entity: Entity,
    readonly customerCode: string,
    readonly company: string,
  ) {}

  static async login(entity: Entity): Promise<MediscaSession> {
    const user = (process.env[`MEDISCA_${entity}`] ?? '').trim();
    const pass = (process.env[`MEDISCA_${entity}_Pass`] ?? '').trim();
    if (user === '' || pass === '') {
      throw new Error(`Missing MEDISCA_${entity} / MEDISCA_${entity}_Pass in web/.env.local`);
    }

    const jar = new CookieJar();

    const home = await fetch(`${BASE}/login`, { headers: { 'User-Agent': UA } });
    jar.absorb(home);
    const locale = jar.value('NEXT_LOCALE') ?? 'en-US';

    const csrfRes = await fetch(`${BASE}/api/auth/csrf`, {
      headers: { 'User-Agent': UA, Cookie: jar.header() },
    });
    jar.absorb(csrfRes);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Cookie: jar.header(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE,
        Referer: `${BASE}/login`,
      },
      body: new URLSearchParams({
        csrfToken, email: user, password: pass, locale,
        callbackUrl: `${BASE}/dashboard`, json: 'true',
      }).toString(),
      redirect: 'manual',
    });
    jar.absorb(res);

    // A NextAuth credentials failure still returns a JSON 200/401 body, so the cookie is the only
    // honest signal that we are actually logged in.
    if (!jar.has(SESSION_COOKIE)) {
      throw new Error(
        `Medisca ${entity}: login failed (no ${SESSION_COOKIE}; HTTP ${res.status}). ` +
        `Check MEDISCA_${entity}_Pass — and note that a MISSING \`locale\` field produces this exact error.`,
      );
    }

    const sess = await fetch(`${BASE}/api/auth/session`, {
      headers: { 'User-Agent': UA, Cookie: jar.header() },
    });
    const payload = (await sess.json()) as SessionPayload;
    const role = payload.user?.user_roles?.[0];
    const customerCode = role?.customer_code ?? '';
    const company = role?.medisca_site ?? '';

    const expected = EXPECTED_CUSTOMER_CODE[entity];
    if (customerCode !== expected) {
      throw new Error(
        `Medisca ${entity}: session is bound to customer ${customerCode || '(none)'}, expected ${expected}. ` +
        `Refusing to continue — these invoices would be booked against the wrong entity.`,
      );
    }

    return new MediscaSession(jar, entity, customerCode, company);
  }

  async get(path: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': UA, Cookie: this.jar.header(), Accept: 'text/html,application/json,*/*' },
      redirect: 'manual',
    });
    this.jar.absorb(res);
    // An expired session silently 307s back to /login and yields an empty invoice list, which would
    // read as "nothing to do" rather than as a failure.
    if (res.status === 307 || res.status === 302) {
      throw new Error(`Medisca ${this.entity}: session expired (redirect to ${res.headers.get('location') ?? '?'})`);
    }
    return { status: res.status, text: await res.text() };
  }

  /**
   * Invoice PDFs live at a fully deterministic URL keyed on customer code, company and the 15-digit
   * zero-padded invoice number. Note it needs NO authentication at all — we send the session anyway
   * rather than depend on that staying true.
   */
  invoicePdfUrl(invoiceNumberRaw: string): string {
    const padded = invoiceNumberRaw.trim().replace(/^0+/, '').padStart(15, '0');
    return `${FILES}/viewfile?Source=Website&Customer=${this.customerCode}&Company=${this.company}&Invoice=${padded}&Language=en`;
  }

  async fetchPdf(invoiceNumberRaw: string): Promise<Buffer> {
    const url = this.invoicePdfUrl(invoiceNumberRaw);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Cookie: this.jar.header(), Referer: BASE },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error(`Medisca invoice ${invoiceNumberRaw}: response is not a PDF (HTTP ${res.status}, ${buf.length} bytes)`);
    }
    return buf;
  }
}
