/**
 * React hook for authentication state with session timeout handling
 *
 * Wrap your app with AuthProvider, then use useAuth() in components.
 *
 * Integration package 1.3.0 behavior, adapted to this app's local proxy
 * routes (/api/auth/me, /api/auth/refresh) which read the session cookie
 * server-side to avoid cross-origin cookie issues.
 *
 * Features:
 * - Initial user fetch via /api/auth/me
 * - Proactive session timeout modal scheduled against the server-reported
 *   `expires_at` (no polling/heartbeat for the primary trigger)
 * - "Stay Signed In" calls /api/auth/refresh, which extends the session
 *   server-side via the auth host while the refresh token is still alive
 * - Tab visibility handling: when a tab becomes visible we re-fetch /api/auth/me
 *   to pick up any expiry advance done by another tab
 * - Safety-net heartbeat that fires only if expires_at was unavailable
 *   (e.g., legacy cookie format)
 */

'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { SessionTimeoutModal } from '@/components/SessionTimeoutModal';

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';

// Configuration
const FALLBACK_HEARTBEAT_INTERVAL_MS = 60 * 1000; // Only used when expires_at is unknown
const TIMEOUT_WARNING_SECONDS = 60; // Show the modal this many seconds before token expiry

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

interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  sessionExpired: boolean;
  /** Unix timestamp (seconds) of current access token expiry, or null if unknown */
  expiresAt: number | null;
  login: (redirectUrl?: string) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  extendSession: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
  /** Disable session heartbeat / scheduling (for testing) */
  disableHeartbeat?: boolean;
  /** Show the warning modal this many seconds before token expiry (default: 60) */
  timeoutWarningSeconds?: number;
}

interface MeResponse {
  user?: User | null;
  expires_at?: number | null;
}

interface ExtendResponse {
  success?: boolean;
  expires_at?: number | null;
}

export function AuthProvider({
  children,
  disableHeartbeat = false,
  timeoutWarningSeconds = TIMEOUT_WARNING_SECONDS,
}: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  // Check session via the local proxy route (reads cookie server-side).
  // Also captures expires_at so the warning modal can be scheduled proactively.
  const checkSession = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch('/api/auth/me');

      if (response.ok) {
        const data = (await response.json()) as MeResponse;
        if (data.user) setUser(data.user);
        setExpiresAt(typeof data.expires_at === 'number' ? data.expires_at : null);
        setSessionExpired(false);
        return true;
      } else {
        return false;
      }
    } catch (err) {
      console.error('Session check failed:', err);
      return false;
    }
  }, []);

  // Extend the session via the local refresh proxy (cookie-based, server-side).
  const extendSession = useCallback(async (): Promise<boolean> => {
    try {
      const refreshResp = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (refreshResp.ok) {
        const data = (await refreshResp.json()) as ExtendResponse;
        if (typeof data.expires_at === 'number') {
          setExpiresAt(data.expires_at);
        }
        // Re-fetch the user so AuthProvider state is fully consistent.
        const valid = await checkSession();
        return valid;
      }

      // Refresh truly failed. Try one more /api/auth/me in case the underlying
      // issue was a transient network blip rather than a dead refresh token.
      const stillValid = await checkSession();
      return stillValid;
    } catch (err) {
      console.error('Session extend failed:', err);
      return false;
    }
  }, [checkSession]);

  // Initial user fetch (uses local API to read cookie server-side)
  const fetchUser = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch('/api/auth/me');

      if (response.ok) {
        const data = (await response.json()) as MeResponse;
        setUser(data.user ?? null);
        setExpiresAt(typeof data.expires_at === 'number' ? data.expires_at : null);
      } else {
        setUser(null);
        setExpiresAt(null);
      }
    } catch (err) {
      console.error('Failed to fetch user:', err);
      setError('Failed to check authentication');
      setUser(null);
      setExpiresAt(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load user on mount
  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  // Primary modal trigger: schedule it to fire `timeoutWarningSeconds` before token
  // expiry. This avoids the old failure-driven model where the modal only appeared
  // *after* /api/auth/me had already 401'd — by which point refresh was usually
  // also dead and "Stay Signed In" had nothing to extend.
  useEffect(() => {
    if (disableHeartbeat) return;
    if (!user || !expiresAt) return;

    const warningAtMs = expiresAt * 1000 - timeoutWarningSeconds * 1000;
    const msUntilWarning = warningAtMs - Date.now();

    if (msUntilWarning <= 0) {
      setShowTimeoutWarning(true);
      return;
    }

    const timer = setTimeout(() => {
      setShowTimeoutWarning(true);
    }, msUntilWarning);

    return () => clearTimeout(timer);
  }, [user, expiresAt, timeoutWarningSeconds, disableHeartbeat]);

  // Safety-net heartbeat: ONLY active when expires_at is unknown (legacy cookie
  // format). With expires_at the scheduled timeout above handles things.
  // Tab visibility re-check always runs so multi-tab refreshes stay in sync.
  const expiresAtRef = useRef(expiresAt);
  useEffect(() => {
    expiresAtRef.current = expiresAt;
  }, [expiresAt]);

  useEffect(() => {
    if (disableHeartbeat || !user) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // A sibling tab may have refreshed the cookie — pick up the new expires_at.
        checkSession();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    let interval: ReturnType<typeof setInterval> | null = null;
    if (expiresAtRef.current == null) {
      // Legacy / unknown-expiry fallback: poll periodically and pop the modal on 401.
      interval = setInterval(async () => {
        const isValid = await checkSession();
        if (!isValid) setShowTimeoutWarning(true);
      }, FALLBACK_HEARTBEAT_INTERVAL_MS);
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (interval) clearInterval(interval);
    };
  }, [user, disableHeartbeat, checkSession]);

  const login = useCallback((redirectUrl?: string) => {
    const redirect = redirectUrl || window.location.href;
    window.location.href = `${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(redirect)}`;
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch(`${AUTH_SERVICE_URL}/api/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          redirect: window.location.origin,
        }),
      });
    } catch (err) {
      console.error('Logout failed:', err);
    }

    setUser(null);
    setExpiresAt(null);
    setSessionExpired(true);
    setShowTimeoutWarning(false);
    window.location.href = `${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(window.location.origin)}`;
  }, []);

  const refreshUser = useCallback(async () => {
    setLoading(true);
    await fetchUser();
  }, [fetchUser]);

  // Handle timeout warning modal actions
  const handleExtendFromModal = useCallback(async (): Promise<boolean> => {
    return extendSession();
  }, [extendSession]);

  const handleDismissModal = useCallback(() => {
    setShowTimeoutWarning(false);
  }, []);

  const handleLogoutFromModal = useCallback(() => {
    logout();
  }, [logout]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        sessionExpired,
        expiresAt,
        login,
        logout,
        refreshUser,
        extendSession,
      }}
    >
      {children}

      {/* Session Timeout Warning Modal (ADP-style) */}
      {showTimeoutWarning && (
        <SessionTimeoutModal
          timeoutSeconds={timeoutWarningSeconds}
          onExtend={handleExtendFromModal}
          onLogout={handleLogoutFromModal}
          onDismiss={handleDismissModal}
        />
      )}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);

  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

/**
 * HOC to protect pages - redirects to login if not authenticated
 */
export function withAuth<P extends object>(
  WrappedComponent: React.ComponentType<P>
): React.FC<P> {
  return function WithAuthComponent(props: P) {
    const { user, loading, login } = useAuth();

    useEffect(() => {
      if (!loading && !user) {
        login();
      }
    }, [loading, user, login]);

    if (loading) {
      return (
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-pulse text-gray-500">Loading...</div>
        </div>
      );
    }

    if (!user) {
      return (
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-gray-500">Redirecting to login...</div>
        </div>
      );
    }

    return <WrappedComponent {...props} />;
  };
}
