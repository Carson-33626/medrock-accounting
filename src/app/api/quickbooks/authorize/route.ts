/**
 * QuickBooks OAuth Authorization Initiator
 *
 * Generates the QB OAuth URL and redirects the user to QuickBooks for authorization.
 *
 * SECURITY (2026-08-10): this route decides which of our four QuickBooks slots a realm will be
 * bound into, so it is gated twice.
 *
 *  - `requireManager()` — the middleware already demands a valid session with the `accounting` app
 *    slug, but that is every accounting user. Binding a company's books is an admin action, and
 *    the route must not depend on middleware alone (DEV_SKIP_AUTH bypasses it wholesale).
 *  - A signed, single-use `state` (see quickbooks-oauth-state.ts). The nonce inside it is also
 *    set as an httpOnly cookie here; the callback accepts a state only if the two agree, which is
 *    what makes a forged callback fail. `state` used to be the location key itself — a guessable
 *    constant that provided no protection at all.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { getAuthorizationUrl, LOCATION_MAPPING, type Location } from '@/lib/quickbooks-multi';
import { createOAuthState, OAUTH_STATE_COOKIE } from '@/lib/quickbooks-oauth-state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();

  try {
    const { searchParams } = new URL(request.url);
    const locationParam = searchParams.get('location');

    // Validate location against the configured companies
    if (!locationParam || !(Object.keys(LOCATION_MAPPING) as string[]).includes(locationParam)) {
      return NextResponse.redirect(
        new URL('/admin/quickbooks?error=invalid_location', request.url)
      );
    }
    const location = locationParam as Location;

    const { state, nonce, maxAgeSeconds } = createOAuthState(location);
    const response = NextResponse.redirect(getAuthorizationUrl(state));

    response.cookies.set(OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      // SameSite=Lax, NOT Strict: Intuit returns the user via a top-level GET navigation from
      // their domain. Strict would withhold the cookie and every legitimate connect would fail.
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      // Scoped to the callback's namespace so it is not attached to unrelated requests.
      path: '/api/quickbooks',
      maxAge: maxAgeSeconds,
    });

    return response;
  } catch (error) {
    console.error('QB authorization error:', error);
    return NextResponse.redirect(
      new URL(
        `/admin/quickbooks?error=${encodeURIComponent('Failed to initiate authorization')}`,
        request.url
      )
    );
  }
}
