/**
 * Client-side authentication helpers
 *
 * Use these in Client Components for auth operations.
 */

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';

// How long to wait on an auth-service request before giving up.
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Role tiers — these MUST match the auth host's `src/lib/role-predicates.ts`.
 *
 *   'user'        → standard employee
 *   'admin'       → MANAGER tier. Gates auth.medrockpharmacy.com/manager
 *   'super_admin' → ADMIN tier. Gates auth.medrockpharmacy.com/admin
 *
 * ⚠️ The stored role string `'admin'` is the **manager** tier, NOT the admin tier.
 */
export type UserRole = 'user' | 'admin' | 'super_admin';

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  /** See {@link UserRole} — `'admin'` is the MANAGER tier, `'super_admin'` is the admin tier. */
  role: string | null;
  phone_verified: boolean;
  regions: string[];
  departments: string[];
  /** Single-valued office location (FL | TN | TX | FOCAS) for Task System grouping. */
  location: 'FL' | 'TN' | 'TX' | 'FOCAS' | null;
  /** Single-valued canonical department for Task System grouping. */
  department: string | null;
}

/** One app the current user may open, from `GET /api/my-apps`. */
export interface UserApp {
  slug: string;
  name: string;
  description: string | null;
  url: string;
}

class MedRockAuthClient {
  private baseUrl: string;

  constructor(baseUrl: string = AUTH_SERVICE_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Redirect to the login page
   */
  login(redirectUrl?: string): void {
    const redirect = redirectUrl || window.location.href;
    window.location.href = `${this.baseUrl}/login?redirect=${encodeURIComponent(redirect)}`;
  }

  /**
   * Get current authenticated user from auth service
   */
  async getUser(): Promise<User | null> {
    try {
      const response = await this.fetchAuth('/api/me', {
        credentials: 'include',
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as { user?: User };
      return data.user || null;
    } catch (error) {
      console.error('Auth check failed:', error);
      return null;
    }
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const user = await this.getUser();
    return user !== null;
  }

  /**
   * List the apps the current user has been granted access to.
   * Useful for building an app-switcher menu.
   */
  async getMyApps(): Promise<UserApp[]> {
    try {
      const response = await this.fetchAuth('/api/my-apps', {
        credentials: 'include',
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as { apps?: UserApp[] };
      return data.apps || [];
    } catch (error) {
      console.error('Failed to load app list:', error);
      return [];
    }
  }

  /**
   * Logout and redirect
   *
   * Clears the `medrock_session` cookie (both the standard and the embed/Partitioned
   * variant) and signs the user out of the auth service.
   *
   * @param redirectUrl - Where to redirect after logout (defaults to auth login page)
   */
  async logout(redirectUrl?: string): Promise<void> {
    try {
      const response = await this.fetchAuth('/api/logout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          redirect: redirectUrl || `${this.baseUrl}/login`,
        }),
      });

      const data = (await response.json()) as { redirect_url?: string };

      // Use redirect URL from response if provided, otherwise use requested URL
      window.location.href = data.redirect_url || redirectUrl || `${this.baseUrl}/login`;
    } catch (error) {
      console.error('Logout failed:', error);
      // Fallback: redirect anyway
      window.location.href = redirectUrl || `${this.baseUrl}/login`;
    }
  }

  /**
   * Get the logout URL for use in links (GET method)
   * @param redirectUrl - Where to redirect after logout
   */
  getLogoutUrl(redirectUrl?: string): string {
    const redirect = redirectUrl || window.location.origin;
    return `${this.baseUrl}/api/logout?redirect=${encodeURIComponent(redirect)}`;
  }

  /**
   * Redirect to the profile page
   */
  profile(): void {
    window.location.href = `${this.baseUrl}/profile`;
  }

  /**
   * Get the profile page URL (for links)
   */
  getProfileUrl(): string {
    return `${this.baseUrl}/profile`;
  }

  /**
   * Redirect to the admin dashboard (super_admin only)
   */
  admin(): void {
    window.location.href = `${this.baseUrl}/admin`;
  }

  /**
   * Get the admin dashboard URL (for links)
   */
  getAdminUrl(): string {
    return `${this.baseUrl}/admin`;
  }

  /**
   * Redirect to the manager dashboard (manager tier: role 'admin' or 'super_admin')
   */
  manager(): void {
    window.location.href = `${this.baseUrl}/manager`;
  }

  /**
   * Get the manager dashboard URL (for links)
   */
  getManagerUrl(): string {
    return `${this.baseUrl}/manager`;
  }

  /**
   * Check if user is in the admin tier (`super_admin`)
   */
  isSuperAdmin(user: User | null): boolean {
    return user?.role === 'super_admin';
  }

  /**
   * Check if user is in the manager tier (`admin` or `super_admin`)
   */
  isManager(user: User | null): boolean {
    return user?.role === 'admin' || user?.role === 'super_admin';
  }

  /**
   * @deprecated Ambiguous since 1.6.0 — the role string `'admin'` is the MANAGER tier.
   *
   * Prior to 1.6.0 this returned true for `'admin' || 'super_admin'`, which silently
   * treated every manager as an admin. It is now an alias of {@link isSuperAdmin}.
   * Use `isSuperAdmin()` for admin surfaces or `isManager()` for manager surfaces.
   */
  isAdmin(user: User | null): boolean {
    return this.isSuperAdmin(user);
  }

  /**
   * Fetch the auth service with a request timeout.
   *
   * NOTE: there is exactly one auth host. A second "backup instance" was speculated in
   * earlier versions of this package but never deployed, so the failover list is gone —
   * it only ever added a failed DNS lookup to every error path.
   */
  private async fetchAuth(endpoint: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// Export singleton instance
export const authClient = new MedRockAuthClient();

// Also export class for custom instances
export { MedRockAuthClient };
