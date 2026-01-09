import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';
const SESSION_COOKIE_NAME = 'medrock_session';

/**
 * POST /api/auth/refresh
 *
 * Attempts to refresh the session by calling the auth service's refresh endpoint.
 * The auth service will use the refresh token from the cookie to issue a new access token.
 */
export async function POST() {
  try {
    // Check if session cookie exists
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);

    if (!sessionCookie) {
      console.log('[/api/auth/refresh] No session cookie found');
      return NextResponse.json({ success: false, message: 'No session found' }, { status: 401 });
    }

    console.log('[/api/auth/refresh] Attempting to refresh session...');

    // Call auth service's refresh endpoint
    const response = await fetch(`${AUTH_SERVICE_URL}/api/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `${SESSION_COOKIE_NAME}=${sessionCookie.value}`,
      },
      credentials: 'include',
    });

    if (response.ok) {
      const data = await response.json();

      // If auth service returned a new cookie, set it
      const setCookieHeader = response.headers.get('set-cookie');
      if (setCookieHeader) {
        // Parse and set the new cookie
        const cookieValue = setCookieHeader.split(';')[0].split('=')[1];
        if (cookieValue) {
          cookieStore.set(SESSION_COOKIE_NAME, cookieValue, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24 * 7, // 7 days
          });
        }
      }

      console.log('[/api/auth/refresh] Session refreshed successfully');
      return NextResponse.json({ success: true, ...data });
    } else {
      console.log('[/api/auth/refresh] Refresh failed:', response.status);
      return NextResponse.json(
        { success: false, message: 'Refresh failed' },
        { status: response.status }
      );
    }
  } catch (error) {
    console.error('[/api/auth/refresh] Refresh error:', error);
    return NextResponse.json(
      { success: false, error: 'Refresh failed' },
      { status: 500 }
    );
  }
}
