/**
 * CSRF protection for the QuickBooks OAuth connect flow.
 *
 * THE ATTACK THIS STOPS. `state` used to be the location key itself — a guessable constant
 * ('MedRock FL'). The callback is a GET, so anyone could make an authenticated admin's browser
 * issue `/api/quickbooks/callback?code=<attacker's code>&realmId=<attacker's realm>&state=MedRock FL`
 * simply by getting them to load a link or an image. Our server would exchange that code and store
 * the ATTACKER'S QuickBooks tokens in our 'MedRock FL' slot. Every later read (chart of accounts,
 * journal entries, the allocation pool) would silently run against their company, and every later
 * write — the payroll JEs we post — would land in it. Being signed in is no defence: the whole
 * point of a CSRF is that it rides the victim's own session.
 *
 * THE FIX. `state` becomes a value that only this server could have minted, for one specific
 * browser, once:
 *
 *   1. `createOAuthState` generates a random nonce and returns
 *      `base64url(location|nonce|expiry).base64url(HMAC-SHA256(payload))`.
 *      The HMAC means an attacker cannot forge a state for a location of their choosing.
 *   2. The same nonce goes into an httpOnly cookie on the redirect to Intuit. The callback only
 *      accepts a state whose nonce matches the cookie, which binds the callback to the browser
 *      that actually STARTED the flow — an attacker's forged request carries the victim's cookie
 *      but the attacker cannot know or set the nonce inside it.
 *   3. The cookie is cleared on use, so a state cannot be replayed.
 *   4. A 10-minute expiry caps the window even if a state leaks (browser history, referrer, logs).
 *
 * SameSite=Lax on the cookie is deliberate and load-bearing: Intuit returns the user via a
 * top-level GET navigation, which Lax permits and Strict would drop — under Strict the cookie
 * would be missing and every legitimate connect would fail.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LOCATION_MAPPING, type Location } from './quickbooks-multi';

/** How long a minted state stays valid. Long enough to log in at Intuit, short enough to matter. */
const STATE_TTL_MS = 10 * 60 * 1000;

export const OAUTH_STATE_COOKIE = 'qb_oauth_state';

/**
 * HMAC key. Prefers a dedicated secret, but falls back to a value DERIVED from the QuickBooks
 * client secret rather than requiring a new environment variable — a missing env var here would
 * break every connect attempt in production, which is a worse outcome than reusing an existing
 * high-entropy server-only secret under a domain-separation label. The label ensures this key can
 * never coincide with the client secret itself.
 */
function stateSecret(): string {
  const dedicated = process.env.QUICKBOOKS_OAUTH_STATE_SECRET;
  if (dedicated && dedicated.length > 0) return dedicated;

  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error(
      'Cannot sign the QuickBooks OAuth state: set QUICKBOOKS_OAUTH_STATE_SECRET or QUICKBOOKS_CLIENT_SECRET',
    );
  }
  return createHmac('sha256', 'qb-oauth-state-v1').update(clientSecret).digest('base64url');
}

const sign = (payload: string): string =>
  createHmac('sha256', stateSecret()).update(payload).digest('base64url');

function isLocation(value: string): value is Location {
  return (Object.keys(LOCATION_MAPPING) as string[]).includes(value);
}

export interface OAuthStateInit {
  /** Put in the `state` query param of the Intuit authorize URL. */
  state: string;
  /** Store in the OAUTH_STATE_COOKIE cookie on the redirect response. */
  nonce: string;
  /** Cookie lifetime in seconds — matches the state's own expiry. */
  maxAgeSeconds: number;
}

/** Mint a signed, single-use state for one location. */
export function createOAuthState(location: Location, now: number = Date.now()): OAuthStateInit {
  const nonce = randomBytes(32).toString('base64url');
  const expiresAt = now + STATE_TTL_MS;
  // '|' is safe as a separator: location keys come from LOCATION_MAPPING and never contain it,
  // and the nonce is base64url. Encoded whole so the separator cannot be smuggled in either.
  const payload = Buffer.from(`${location}|${nonce}|${expiresAt}`, 'utf8').toString('base64url');
  return { state: `${payload}.${sign(payload)}`, nonce, maxAgeSeconds: Math.floor(STATE_TTL_MS / 1000) };
}

export type OAuthStateFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'unknown_location'
  | 'missing_cookie'
  | 'nonce_mismatch';

export type OAuthStateResult =
  | { ok: true; location: Location }
  | { ok: false; reason: OAuthStateFailure };

/**
 * Verify a callback's `state` against the nonce cookie set when the flow started.
 *
 * Order matters: signature BEFORE parsing the payload's contents, so nothing an attacker controls
 * is interpreted until it is proven to have come from us.
 */
export function verifyOAuthState(
  state: string | null,
  cookieNonce: string | null | undefined,
  now: number = Date.now(),
): OAuthStateResult {
  if (!state) return { ok: false, reason: 'malformed' };

  const dot = state.lastIndexOf('.');
  if (dot <= 0 || dot === state.length - 1) return { ok: false, reason: 'malformed' };

  const payload = state.slice(0, dot);
  const provided = state.slice(dot + 1);
  const expected = sign(payload);

  // Length check first: timingSafeEqual throws on a length mismatch, and the length of a SHA-256
  // base64url digest is public information anyway.
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(providedBuf, expectedBuf)) return { ok: false, reason: 'bad_signature' };

  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  const parts = decoded.split('|');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [location, nonce, expiresRaw] = parts;
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed' };
  if (now > expiresAt) return { ok: false, reason: 'expired' };
  if (!isLocation(location)) return { ok: false, reason: 'unknown_location' };

  // The signature proves WE minted this state; the cookie proves it was minted for THIS browser.
  // Both are required — a signed state replayed from another browser must not bind tokens.
  if (!cookieNonce) return { ok: false, reason: 'missing_cookie' };
  const cookieBuf = Buffer.from(cookieNonce);
  const nonceBuf = Buffer.from(nonce);
  if (cookieBuf.length !== nonceBuf.length) return { ok: false, reason: 'nonce_mismatch' };
  if (!timingSafeEqual(cookieBuf, nonceBuf)) return { ok: false, reason: 'nonce_mismatch' };

  return { ok: true, location };
}

/** Short, non-leaky messages for the `?error=` param on the admin page. */
export const STATE_FAILURE_MESSAGE: Record<OAuthStateFailure, string> = {
  malformed: 'invalid_state',
  bad_signature: 'invalid_state',
  expired: 'state_expired',
  unknown_location: 'invalid_location',
  missing_cookie: 'state_expired',
  nonce_mismatch: 'invalid_state',
};
