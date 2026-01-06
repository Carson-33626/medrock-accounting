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

  // Check for session cookie from centralized auth service
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME);

  if (!sessionCookie?.value) {
    // No session - redirect to centralized auth service
    const currentUrl = request.url;
    const loginUrl = `${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(currentUrl)}`;

    return NextResponse.redirect(loginUrl);
  }

  // Session exists - allow request to proceed
  // Token validation happens in server components/API routes
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
