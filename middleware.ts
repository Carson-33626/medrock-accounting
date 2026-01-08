import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Auth service URL
const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';

// Cookie name from centralized auth service
const SESSION_COOKIE_NAME = 'medrock_session';

// Public routes that don't require authentication
const PUBLIC_ROUTES = [
  '/auth/login',
  '/api/health',
  '/terms',      // Public for QuickBooks app verification
  '/privacy',    // Public for QuickBooks app verification
];

// Routes that handle their own auth (API routes that use Basic Auth, etc.)
const SELF_AUTH_ROUTES = [
  '/api/coupons', // Uses internal data, no user auth needed
];

// Static files and Next.js internals to skip
const EXCLUDED_PREFIXES = [
  '/_next',
  '/favicon.ico',
  '/public',
];

// Cookie payload structure (matches auth service format)
interface CookiePayload {
  at: string;  // access token
  rt: string;  // refresh token
  exp: number; // expires at (unix timestamp)
}

/**
 * Decode and validate session cookie
 * Returns null if cookie is invalid or expired
 */
function validateSessionCookie(cookieValue: string): { accessToken: string; expired: boolean } | null {
  if (!cookieValue) return null;

  try {
    // Try new format first (URL-safe base64 encoded JSON)
    let base64 = cookieValue
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    // Add padding if needed
    while (base64.length % 4) {
      base64 += '=';
    }

    // Decode using atob (works in Edge Runtime)
    const decoded = atob(base64);
    const payload = JSON.parse(decoded) as CookiePayload;

    if (payload.at && payload.exp) {
      // Check if token is expired (with 5 second buffer)
      const now = Math.floor(Date.now() / 1000);
      const expired = payload.exp < (now - 5);

      return {
        accessToken: payload.at,
        expired,
      };
    }
  } catch {
    // Not base64 JSON, try old format
  }

  // Old format: raw access token (JWT has dots)
  if (cookieValue.includes('.')) {
    // For old format, we can't check expiration without decoding JWT
    // We'll need to parse the JWT payload to check exp
    try {
      const parts = cookieValue.split('.');
      if (parts.length === 3) {
        // Decode JWT payload (second part)
        const payload = JSON.parse(atob(parts[1]));
        const now = Math.floor(Date.now() / 1000);
        const expired = payload.exp ? payload.exp < (now - 5) : false;

        return {
          accessToken: cookieValue,
          expired,
        };
      }
    } catch {
      // JWT decode failed
    }
  }

  return null;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip static files and Next.js internals
  if (EXCLUDED_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  // Allow public routes
  if (PUBLIC_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'))) {
    return NextResponse.next();
  }

  // Allow self-authenticating API routes
  if (SELF_AUTH_ROUTES.some(route => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  // DEVELOPMENT MODE: Skip auth if DEV_SKIP_AUTH is enabled
  // WARNING: This should NEVER be enabled in production!
  if (process.env.DEV_SKIP_AUTH === 'true') {
    console.warn('⚠️  DEV MODE: Authentication is DISABLED. This should only be used for local testing!');
    return NextResponse.next();
  }

  // Check for session cookie from centralized auth service
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME);

  if (!sessionCookie?.value) {
    // No session - redirect to centralized auth service
    const currentUrl = request.url;
    const loginUrl = `${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(currentUrl)}`;

    return NextResponse.redirect(loginUrl);
  }

  // Validate session cookie and check expiration
  const sessionData = validateSessionCookie(sessionCookie.value);

  if (!sessionData || sessionData.expired) {
    // Invalid or expired session - redirect to login
    const currentUrl = request.url;
    const loginUrl = `${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(currentUrl)}`;

    return NextResponse.redirect(loginUrl);
  }

  // Session exists and is valid - allow request to proceed
  // Pass the current URL as a header for redirect support in server components
  const response = NextResponse.next();
  response.headers.set('x-url', request.url);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
