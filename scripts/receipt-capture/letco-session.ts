// web/scripts/receipt-capture/letco-session.ts
// Authenticated HTTP session for the Fagron Shop portal (Sana Commerce on IIS).
//
// NO BROWSER. The server rejects headless Chromium (ERR_HTTP2_PROTOCOL_ERROR) but serves plain
// fetch normally, so this is both simpler than a browser adapter and the only unattended option.
import { CookieJar, extractAntiForgeryToken } from './letco-http';
import type { Entity } from '../ramp-split-push/types';

const BASE = 'https://shop.fagron.us';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const AUTH_COOKIE = '.ASPXAUTH_SS';

function setCookies(res: Response): string[] {
  return typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
}

export class LetcoSession {
  private constructor(private readonly jar: CookieJar, readonly entity: Entity) {}

  static async login(entity: Entity): Promise<LetcoSession> {
    const user = process.env[`LETCO_${entity}`];
    const pass = process.env[`LETCO_${entity}_Pass`];
    if (!user || !pass) throw new Error(`Missing LETCO_${entity} / LETCO_${entity}_Pass in web/.env.local`);

    const jar = new CookieJar();
    const page = await fetch(`${BASE}/profile/login`, { headers: { 'User-Agent': UA } });
    jar.absorb(setCookies(page));
    const token = extractAntiForgeryToken(await page.text());

    const form = new URLSearchParams({ UserName: user, Password: pass, RememberMe: 'true' });
    if (token !== null) form.set('__RequestVerificationToken', token);

    const res = await fetch(`${BASE}/profile/login`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Cookie: jar.header(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE,
        Referer: `${BASE}/profile/login`,
      },
      body: form.toString(),
      redirect: 'manual',
    });
    jar.absorb(setCookies(res));

    // A failed login also returns HTML with a 200, so the auth cookie is the only honest signal.
    if (!jar.has(AUTH_COOKIE)) {
      throw new Error(`Letco ${entity}: login failed (no ${AUTH_COOKIE}; HTTP ${res.status})`);
    }
    return new LetcoSession(jar, entity);
  }

  async get(path: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': UA, Cookie: this.jar.header(), Accept: 'text/html,application/json,*/*' },
    });
    this.jar.absorb(setCookies(res));
    return { status: res.status, text: await res.text() };
  }

  async postForm(path: string, fields: Record<string, string>): Promise<{ status: number; text: string; contentType: string }> {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Cookie: this.jar.header(),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest', // without this the grid endpoint returns HTML, not JSON
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Origin: BASE,
        Referer: `${BASE}${path}`,
      },
      body: new URLSearchParams(fields).toString(),
    });
    this.jar.absorb(setCookies(res));
    return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
  }

  async getBinary(path: string): Promise<{ status: number; buffer: Buffer; contentType: string }> {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': UA, Cookie: this.jar.header(), Accept: 'application/pdf,*/*' },
    });
    this.jar.absorb(setCookies(res));
    return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
  }
}
