/**
 * Server-side authentication helpers
 *
 * Use these in Server Components and API routes to get/validate the current user.
 */

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://amy.medrockpharmacy.com';
const SESSION_COOKIE_NAME = 'medrock_session';

// Cookie payload structure (matches auth service format)
interface CookiePayload {
  at: string;  // access token
  rt: string;  // refresh token
  exp: number; // expires at (unix timestamp)
}

/**
 * Decode tokens from cookie value
 * Supports both old format (raw JWT) and new format (URL-safe base64 JSON)
 *
 * IMPORTANT: If your app has custom API routes that read the medrock_session cookie,
 * you MUST use this function to decode the cookie value before passing to Supabase.
 *
 * @example
 * // In your custom API route
 * import { decodeTokens } from '@/lib/auth';
 *
 * const cookieValue = cookies.get('medrock_session')?.value;
 * const decoded = decodeTokens(cookieValue);
 * const { data } = await supabase.auth.getUser(decoded?.accessToken);
 */
export function decodeTokens(cookieValue: string): { accessToken: string; refreshToken?: string; expiresAt?: number } | null {
  if (!cookieValue) {
    console.log('[decodeTokens] No cookie value');
    return null;
  }

  // Clean up the cookie value
  let value = cookieValue.trim();

  // Remove surrounding quotes if present
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
    console.log('[decodeTokens] Stripped quotes from cookie');
  }

  // URL-decode the cookie value (handles %3D -> = etc)
  try {
    if (value.includes('%')) {
      value = decodeURIComponent(value);
      console.log('[decodeTokens] URL-decoded cookie');
    }
  } catch {
    // Not URL-encoded, use as-is
  }

  console.log('[decodeTokens] Cookie length:', value.length);
  console.log('[decodeTokens] Cookie starts with:', value.substring(0, 30));

  try {
    // Try new format first (URL-safe base64 encoded JSON)
    // Convert URL-safe base64 back to standard base64
    let base64 = value
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    // Add padding if needed
    while (base64.length % 4) {
      base64 += '=';
    }

    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    console.log('[decodeTokens] Decoded JSON starts with:', decoded.substring(0, 50));

    const payload = JSON.parse(decoded) as CookiePayload;

    if (payload.at && payload.rt) {
      console.log('[decodeTokens] Successfully decoded new format, token starts with:', payload.at.substring(0, 20));
      return {
        accessToken: payload.at,
        refreshToken: payload.rt,
        expiresAt: payload.exp,
      };
    }
    console.log('[decodeTokens] Decoded but missing at/rt fields');
  } catch (e) {
    console.log('[decodeTokens] Failed to decode as base64 JSON:', e);
    // Not base64 JSON, fall through to old format
  }

  // Old format: raw access token (JWT has dots)
  if (value.includes('.')) {
    console.log('[decodeTokens] Using old JWT format');
    return { accessToken: value };
  }

  console.log('[decodeTokens] Could not decode cookie');
  return null;
}

// Supabase client for token validation
function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export interface AuthUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  role: 'user' | 'admin' | 'super_admin';
  regions?: string[];
  departments?: string[];
}

/**
 * Get the current authenticated user
 * Returns null if not authenticated or token is invalid
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const cookieStore = await cookies();
    const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;

    if (!cookieValue) {
      return null;
    }

    // Decode token from cookie (supports both old JWT and new encoded format)
    const decoded = decodeTokens(cookieValue);
    if (!decoded) {
      return null;
    }

    // Validate token with Supabase
    const supabase = getSupabase();
    console.log('[getCurrentUser] Validating token with Supabase...');
    const { data: authData, error: authError } = await supabase.auth.getUser(decoded.accessToken);

    if (authError) {
      console.log('[getCurrentUser] Supabase auth error:', authError.message);
      return null;
    }

    if (!authData.user) {
      console.log('[getCurrentUser] No user returned from Supabase');
      return null;
    }

    console.log('[getCurrentUser] Token valid, user id:', authData.user.id);

    // Get user profile from database
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, email, full_name, role, regions, departments')
      .eq('id', authData.user.id)
      .single();

    if (profileError || !profile) {
      // User exists in auth but not in profiles - return basic info
      return {
        id: authData.user.id,
        email: authData.user.email || '',
        first_name: null,
        last_name: null,
        full_name: null,
        role: 'user',
      };
    }

    // Parse full_name into first/last
    const nameParts = profile.full_name?.split(' ') || [];
    const firstName = nameParts[0] || null;
    const lastName = nameParts.slice(1).join(' ') || null;

    return {
      id: profile.id,
      email: profile.email,
      first_name: firstName,
      last_name: lastName,
      full_name: profile.full_name,
      role: profile.role || 'user',
      regions: profile.regions,
      departments: profile.departments,
    };
  } catch (error) {
    console.error('Auth error:', error);
    return null;
  }
}

/**
 * Get the current request URL from headers (for redirect after login)
 */
async function getCurrentUrl(): Promise<string> {
  const headersList = await headers();

  // Try to get the full URL from middleware-set header
  const xUrl = headersList.get('x-url');
  if (xUrl) return xUrl;

  // Reconstruct from forwarded headers
  const proto = headersList.get('x-forwarded-proto') || 'https';
  const host = headersList.get('x-forwarded-host') || headersList.get('host') || '';
  const path = headersList.get('x-invoke-path') || '/';

  if (host) {
    return `${proto}://${host}${path}`;
  }

  // Fallback - use APP_URL
  return APP_URL;
}

/**
 * Require authentication - redirects to login if not authenticated
 * Use in Server Components that require a logged-in user
 */
export async function requireAuth(): Promise<AuthUser> {
  const user = await getCurrentUser();

  if (!user) {
    const currentUrl = await getCurrentUrl();
    redirect(`${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(currentUrl)}`);
  }

  return user;
}

/**
 * Require admin role - redirects if not admin
 */
export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireAuth();

  if (user.role !== 'admin' && user.role !== 'super_admin') {
    redirect('/'); // Redirect to home if not admin
  }

  return user;
}

/**
 * Require super admin role - redirects if not super admin
 */
export async function requireSuperAdmin(): Promise<AuthUser> {
  const user = await requireAuth();

  if (user.role !== 'super_admin') {
    redirect('/'); // Redirect to home if not super admin
  }

  return user;
}

/**
 * Check if user has one of the allowed roles
 */
export function hasRole(user: AuthUser, allowedRoles: string[]): boolean {
  return allowedRoles.includes(user.role);
}

/**
 * Get auth token for API calls (if needed)
 * Returns the decoded access token from the session cookie
 */
export async function getAuthToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!cookieValue) {
    return null;
  }

  const decoded = decodeTokens(cookieValue);
  return decoded?.accessToken || null;
}
