import { describe, it, expect } from 'vitest';
import { CookieJar, extractAntiForgeryToken } from './letco-http';

describe('CookieJar', () => {
  it('keeps the value before the first attribute and drops the attributes', () => {
    const jar = new CookieJar();
    jar.absorb(['.ASPXAUTH_SS=abc123; path=/; HttpOnly; SameSite=Lax']);
    expect(jar.header()).toBe('.ASPXAUTH_SS=abc123');
  });

  it('overwrites a cookie when the server reissues it', () => {
    const jar = new CookieJar();
    jar.absorb(['LanguageId=1; path=/']);
    jar.absorb(['LanguageId=2; path=/']);
    expect(jar.header()).toBe('LanguageId=2');
  });

  it('joins multiple cookies with "; " for the request header', () => {
    const jar = new CookieJar();
    jar.absorb(['LanguageId=1; path=/', '.ASPXAUTH_SS=xyz; path=/']);
    expect(jar.header()).toBe('LanguageId=1; .ASPXAUTH_SS=xyz');
  });

  it('reports whether the auth cookie has been issued', () => {
    const jar = new CookieJar();
    expect(jar.has('.ASPXAUTH_SS')).toBe(false);
    jar.absorb(['.ASPXAUTH_SS=xyz; path=/']);
    expect(jar.has('.ASPXAUTH_SS')).toBe(true);
  });

  it('ignores malformed Set-Cookie lines rather than storing junk', () => {
    const jar = new CookieJar();
    jar.absorb(['', 'novalue', '=orphan']);
    expect(jar.header()).toBe('');
  });
});

describe('extractAntiForgeryToken', () => {
  it('reads the hidden field value', () => {
    const html = '<input name="__RequestVerificationToken" type="hidden" value="TOKEN-123" />';
    expect(extractAntiForgeryToken(html)).toBe('TOKEN-123');
  });

  it('returns null when the form has no token', () => {
    expect(extractAntiForgeryToken('<form></form>')).toBeNull();
  });
});
