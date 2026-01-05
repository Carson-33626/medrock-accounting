/**
 * Client-side authentication helpers
 *
 * Use these in Client Components for auth operations.
 */

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';

// Fallback URLs for redundancy
const AUTH_URLS = [
  AUTH_SERVICE_URL,
  'https://auth2.medrockpharmacy.com', // Backup instance
];

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  phone_verified: boolean;
  regions: string[];
  departments: string[];
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
      const response = await this.fetchWithFallback('/api/me', {
        credentials: 'include',
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
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
   * Logout and redirect
   * @param redirectUrl - Where to redirect after logout (defaults to auth login page)
   */
  async logout(redirectUrl?: string): Promise<void> {
    try {
      const response = await this.fetchWithFallback('/api/logout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          redirect: redirectUrl || `${this.baseUrl}/login`,
        }),
      });

      const data = await response.json();

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
   * Check if user is a super admin
   */
  isSuperAdmin(user: User | null): boolean {
    return user?.role === 'super_admin';
  }

  /**
   * Check if user is an admin (admin or super_admin)
   */
  isAdmin(user: User | null): boolean {
    return user?.role === 'admin' || user?.role === 'super_admin';
  }

  /**
   * Fetch with automatic failover to backup auth service
   */
  private async fetchWithFallback(
    endpoint: string,
    options: RequestInit
  ): Promise<Response> {
    for (const baseUrl of AUTH_URLS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`${baseUrl}${endpoint}`, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok || response.status < 500) {
          return response;
        }
      } catch (error) {
        console.warn(`Auth service ${baseUrl} failed, trying next...`);
      }
    }

    throw new Error('All auth services unavailable');
  }
}

// Export singleton instance
export const authClient = new MedRockAuthClient();

// Also export class for custom instances
export { MedRockAuthClient };
