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

// NOTE: Cookie validation removed - token validation happens in server components/API routes
// The middleware just checks if the cookie exists, actual validation is done server-side

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

  // DEBUG: Log all cookies to see what's available
  const allCookies = request.cookies.getAll();
  console.log('[Middleware] Path:', pathname);
  console.log('[Middleware] All cookies:', allCookies.map(c => c.name).join(', '));
  console.log('[Middleware] medrock_session cookie:', sessionCookie ? 'FOUND' : 'NOT FOUND');

  if (!sessionCookie?.value) {
    // No session - redirect to centralized auth service
    console.log('[Middleware] No session cookie, redirecting to auth');
    const currentUrl = request.url;
    const loginUrl = `${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(currentUrl)}`;

    return NextResponse.redirect(loginUrl);
  }

  console.log('[Middleware] Session cookie found, length:', sessionCookie.value.length);

  // Session exists - check app access
  // REQUIRED: Verify user has permission to access this app
  try {
    const accessCheck = await fetch(
      `${AUTH_SERVICE_URL}/api/access/check?app=amy`,
      {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie.value}`,
        },
      }
    );

    // Handle access denied
    if (accessCheck.status === 403) {
      const data = await accessCheck.json().catch(() => ({}));
      const reason = data.reason || 'You do not have permission to access this application.';

      return new NextResponse(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Denied</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    .container { background: white; border-radius: 12px; padding: 48px 32px; max-width: 480px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    h1 { color: #e53e3e; font-size: 24px; margin: 0 0 16px; }
    p { color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 24px; }
    a { display: inline-block; background: #667eea; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; transition: background 0.2s; }
    a:hover { background: #5568d3; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚫 Access Denied</h1>
    <p>${reason}</p>
    <p style="font-size: 14px; color: #718096;">Please contact your administrator if you believe this is an error.</p>
    <a href="${AUTH_SERVICE_URL}/login">Return to Login</a>
  </div>
</body>
</html>`,
        { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }

    // Handle auth errors (shouldn't happen since we already checked cookie, but failsafe)
    if (accessCheck.status === 401) {
      const currentUrl = request.url;
      const loginUrl = `${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(currentUrl)}`;
      return NextResponse.redirect(loginUrl);
    }

    // Access check failed for other reasons (500, timeout, etc.)
    if (!accessCheck.ok) {
      console.error(`Access check failed with status ${accessCheck.status}`);
      // Allow access anyway to avoid blocking users during auth service outages
      // In production, you might want to be more strict here
    }
  } catch (error) {
    console.error('Access check request failed:', error);
    // Allow access anyway to avoid blocking users during network issues
    // In production, you might want to be more strict here
  }

  // Access granted - allow request to proceed
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
