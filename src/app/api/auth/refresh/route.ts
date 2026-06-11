import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { decodeTokens } from '@/lib/auth';

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';
const SESSION_COOKIE_NAME = 'medrock_session';

interface AuthHostRefreshResponse {
  success?: boolean;
  expires_at?: number | null;
}

/**
 * POST /api/auth/refresh
 *
 * Extends the session via the auth host. Prefers POST /api/extend-session
 * (auth host 1.9+, reads the refresh token from the cookie server-side and
 * rewrites it — the "Stay Signed In" fix from integration package 1.2.0),
 * falling back to the older /api/refresh endpoint if extend-session is absent.
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

    console.log('[/api/auth/refresh] Attempting to extend session...');

    const headers = {
      'Content-Type': 'application/json',
      Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie.value}`,
    };

    // Preferred: cookie-based server-side refresh (auth host 1.9+)
    let response = await fetch(`${AUTH_SERVICE_URL}/api/extend-session`, {
      method: 'POST',
      headers,
    });

    // Fallback for older auth hosts without extend-session
    if (response.status === 404) {
      console.log('[/api/auth/refresh] extend-session not available, falling back to /api/refresh');
      response = await fetch(`${AUTH_SERVICE_URL}/api/refresh`, {
        method: 'POST',
        headers,
      });
    }

    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as AuthHostRefreshResponse;
      let expiresAt: number | null = typeof data.expires_at === 'number' ? data.expires_at : null;

      // If auth service returned a new cookie, set it locally
      const setCookieHeader = response.headers.get('set-cookie');
      if (setCookieHeader) {
        const firstPair = setCookieHeader.split(';')[0];
        const eq = firstPair.indexOf('=');
        const cookieValue = eq >= 0 ? firstPair.slice(eq + 1) : '';
        if (cookieValue) {
          cookieStore.set(SESSION_COOKIE_NAME, cookieValue, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24 * 7, // 7 days
          });
          // Derive expiry from the fresh cookie when the host didn't report it
          if (expiresAt === null) {
            const decoded = decodeTokens(cookieValue);
            if (decoded && typeof decoded.expiresAt === 'number') {
              expiresAt = decoded.expiresAt;
            }
          }
        }
      }

      console.log('[/api/auth/refresh] Session extended successfully');
      return NextResponse.json({ success: true, expires_at: expiresAt });
    }

    console.log('[/api/auth/refresh] Extend failed:', response.status);
    return NextResponse.json(
      { success: false, message: 'Refresh failed' },
      { status: response.status }
    );
  } catch (error) {
    console.error('[/api/auth/refresh] Refresh error:', error);
    return NextResponse.json(
      { success: false, error: 'Refresh failed' },
      { status: 500 }
    );
  }
}
