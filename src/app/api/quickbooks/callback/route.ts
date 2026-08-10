/**
 * QuickBooks OAuth 2.0 callback handler - Multi-Location Support
 *
 * Handles the OAuth redirect from QuickBooks after user authorizes the app.
 * Exchanges the authorization code for access/refresh tokens.
 *
 * SECURITY (2026-08-10): this route writes the tokens that every later QuickBooks read and write
 * runs against, so the location it binds them to now comes ONLY from a verified state:
 *
 *  - `requireAdmin()` before anything else.
 *  - `verifyOAuthState` checks the HMAC (we minted it), the expiry, and that the nonce matches the
 *    httpOnly cookie set when the flow started (same browser started it). The location is read out
 *    of that verified payload — it is never taken from an unauthenticated query param again.
 *  - The nonce cookie is cleared on every outcome, so a state cannot be replayed.
 *
 * Without this, a GET like `/api/quickbooks/callback?code=…&realmId=…&state=MedRock FL` triggered
 * in an admin's browser would have bound an ATTACKER'S QuickBooks company into our FL slot.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { exchangeCodeForTokens, fetchCompanyName, storeTokens } from '@/lib/quickbooks-multi';
import { OAUTH_STATE_COOKIE, STATE_FAILURE_MESSAGE, verifyOAuthState } from '@/lib/quickbooks-oauth-state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Every exit from this route clears the single-use nonce. Centralised so a future early-return
 * cannot forget it and leave a replayable state behind.
 */
function redirectClearingState(request: NextRequest, target: string): NextResponse {
  const response = NextResponse.redirect(new URL(target, request.url));
  response.cookies.set(OAUTH_STATE_COOKIE, '', { httpOnly: true, path: '/api/quickbooks', maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const { searchParams } = new URL(request.url);

    const code = searchParams.get('code');
    const realmId = searchParams.get('realmId'); // QB Company ID
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // Handle OAuth error
    if (error) {
      console.error('OAuth error:', error);
      return redirectClearingState(request, `/admin/quickbooks?error=${encodeURIComponent(error)}`);
    }

    // Validate required parameters
    if (!code || !realmId) {
      return redirectClearingState(request, '/admin/quickbooks?error=missing_params');
    }

    // The location comes from the VERIFIED state — signature, expiry, and the nonce cookie must
    // all agree. A failure here means this callback did not originate from a connect WE started.
    const verified = verifyOAuthState(state, request.cookies.get(OAUTH_STATE_COOKIE)?.value);
    if (!verified.ok) {
      console.error('QB OAuth callback rejected: state verification failed —', verified.reason);
      return redirectClearingState(
        request,
        `/admin/quickbooks?error=${encodeURIComponent(STATE_FAILURE_MESSAGE[verified.reason])}`,
      );
    }
    const location = verified.location;

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, location);

    // Store realmId from URL (sometimes not in token response)
    tokens.realm_id = realmId;

    // Record the realm's actual company name (falls back to LOCATION_MAPPING inside storeTokens).
    const companyName = await fetchCompanyName(tokens.access_token, realmId);
    if (companyName) tokens.company_name = companyName;

    // Save to database
    await storeTokens(tokens);

    console.log(`QuickBooks connected successfully for ${location}. RealmID:`, realmId);

    // Redirect to admin page with success and location
    return redirectClearingState(
      request,
      `/admin/quickbooks?success=true&location=${encodeURIComponent(location)}`,
    );
  } catch (error) {
    console.error('QB OAuth callback error:', error);

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    return redirectClearingState(request, `/admin/quickbooks?error=${encodeURIComponent(errorMessage)}`);
  }
}
