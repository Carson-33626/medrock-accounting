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
    const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

    if (!token) {
      return null;
    }

    // Validate token with Supabase
    const supabase = getSupabase();
    const { data: authData, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authData.user) {
      return null;
    }

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
 */
export async function getAuthToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value || null;
}
