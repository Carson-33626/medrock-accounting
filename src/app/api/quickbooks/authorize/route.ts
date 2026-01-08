/**
 * QuickBooks OAuth Authorization Initiator
 *
 * Generates the QB OAuth URL and redirects the user to QuickBooks for authorization.
 * Location is passed via query param and included in state parameter for callback.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizationUrl, type Location } from '@/lib/quickbooks-multi';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const location = searchParams.get('location') as Location | null;

    // Validate location
    if (!location || !['MedRock FL', 'MedRock TN', 'MedRock TX'].includes(location)) {
      return NextResponse.redirect(
        new URL('/admin/quickbooks?error=invalid_location', request.url)
      );
    }

    // Generate OAuth URL with location in state parameter
    const authUrl = getAuthorizationUrl(location);

    // Redirect user to QuickBooks for authorization
    return NextResponse.redirect(authUrl);
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
