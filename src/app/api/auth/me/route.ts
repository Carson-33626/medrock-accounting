import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth';

const SESSION_COOKIE_NAME = 'medrock_session';

/**
 * GET /api/auth/me
 *
 * Returns the current authenticated user by reading the session cookie.
 * This allows client components to check auth status without cross-origin issues.
 */
export async function GET() {
  try {
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

    console.log('[/api/auth/me] User authenticated:', user.email);
    return NextResponse.json({ user });
  } catch (error) {
    console.error('[/api/auth/me] Auth check error:', error);
    return NextResponse.json({ user: null, error: 'Auth check failed' }, { status: 500 });
  }
}
