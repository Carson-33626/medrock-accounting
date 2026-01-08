/**
 * QuickBooks OAuth 2.0 callback handler - Multi-Location Support
 *
 * Handles the OAuth redirect from QuickBooks after user authorizes the app.
 * Exchanges the authorization code for access/refresh tokens.
 * Supports multiple locations (FL, TN, TX) via state parameter.
 */

import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens, storeTokens, type Location } from '@/lib/quickbooks-multi';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const code = searchParams.get('code');
    const realmId = searchParams.get('realmId'); // QB Company ID
    const state = searchParams.get('state'); // Location from authorization URL
    const error = searchParams.get('error');

    // Handle OAuth error
    if (error) {
      console.error('OAuth error:', error);
      return NextResponse.redirect(
        new URL(`/admin/quickbooks?error=${encodeURIComponent(error)}`, request.url)
      );
    }

    // Validate required parameters
    if (!code || !realmId || !state) {
      return NextResponse.redirect(
        new URL('/admin/quickbooks?error=missing_params', request.url)
      );
    }

    // State parameter contains the location
    const location = state as Location;

    // Validate location
    if (!['MedRock FL', 'MedRock TN', 'MedRock TX'].includes(location)) {
      return NextResponse.redirect(
        new URL('/admin/quickbooks?error=invalid_location', request.url)
      );
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, location);

    // Store realmId from URL (sometimes not in token response)
    tokens.realm_id = realmId;

    // Save to database
    await storeTokens(tokens);

    console.log(`QuickBooks connected successfully for ${location}. RealmID:`, realmId);

    // Redirect to admin page with success and location
    return NextResponse.redirect(
      new URL(
        `/admin/quickbooks?success=true&location=${encodeURIComponent(location)}`,
        request.url
      )
    );
  } catch (error) {
    console.error('QB OAuth callback error:', error);

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.redirect(
      new URL(
        `/admin/quickbooks?error=${encodeURIComponent(errorMessage)}`,
        request.url
      )
    );
  }
}
