import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getCurrentUser, decodeTokens } from '@/lib/auth';

const SESSION_COOKIE_NAME = 'medrock_session';

/**
 * Extract the access token expiry (unix seconds) for proactive session
 * timeout scheduling (integration package 1.3.0 behavior).
 * Prefers the cookie's exp field; falls back to the JWT's own exp claim.
 */
function getExpiresAt(cookieValue: string): number | null {
  const decoded = decodeTokens(cookieValue);
  if (!decoded) return null;
  if (typeof decoded.expiresAt === 'number') return decoded.expiresAt;

  // Legacy cookie format: decode the JWT payload's exp claim
  try {
    const parts = decoded.accessToken.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { exp?: number };
      if (typeof payload.exp === 'number') return payload.exp;
    }
  } catch {
    // Unparseable JWT - no expiry available
  }
  return null;
}

/**
 * GET /api/auth/me
 *
 * Returns the current authenticated user by reading the session cookie.
 * This allows client components to check auth status without cross-origin issues.
 * Includes expires_at (access token expiry, unix seconds) so the client can
 * schedule the session timeout modal proactively.
 */
export async function GET() {
  try {
    // DEVELOPMENT MODE: Skip cookie check and return mock user
    if (process.env.DEV_SKIP_AUTH === 'true') {
      console.log('[/api/auth/me] DEV MODE: Returning mock super_admin user');
      const user = await getCurrentUser(); // This will return the mock user
      return NextResponse.json({ user, expires_at: null });
    }

    // Debug: check if cookie is present
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);

    if (!sessionCookie) {
      console.log('[/api/auth/me] No session cookie found');
      return NextResponse.json({ user: null }, { status: 401 });
    }

    console.log('[/api/auth/me] Cookie found, validating...');

    const user = await getCurrentUser();

    if (!user) {
      console.log('[/api/auth/me] Token validation failed');
      return NextResponse.json({ user: null }, { status: 401 });
    }

    const expiresAt = getExpiresAt(sessionCookie.value);

    console.log('[/api/auth/me] User authenticated:', user.email);
    return NextResponse.json({ user, expires_at: expiresAt });
  } catch (error) {
    console.error('[/api/auth/me] Auth check error:', error);
    return NextResponse.json({ user: null, error: 'Auth check failed' }, { status: 500 });
  }
}
