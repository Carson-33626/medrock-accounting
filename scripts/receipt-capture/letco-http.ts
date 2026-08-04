// web/scripts/receipt-capture/letco-http.ts
// HTTP primitives for the Fagron Shop portal. Kept free of network calls so they can be tested.
//
// The portal is Sana Commerce on IIS and REJECTS headless Chromium
// (ERR_HTTP2_PROTOCOL_ERROR), while plain fetch returns 200 — so this vendor is driven over HTTP
// with a cookie jar rather than a browser. That also makes it the only vendor that can run
// unattended with no session bootstrap.

/** Minimal single-host cookie jar: last write wins, attributes discarded. */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(setCookie: string[]): void {
    for (const line of setCookie) {
      const first = line.split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue; // malformed or attribute-only line
      this.jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }
}

// The token is issued per request as BOTH a cookie and a hidden form field; the POST must echo the
// field or the login silently fails. It is absent from saved/static copies of the page.
export function extractAntiForgeryToken(html: string): string | null {
  const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html);
  return m === null ? null : m[1];
}
