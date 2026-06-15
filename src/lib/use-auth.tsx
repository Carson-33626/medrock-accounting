/**
 * React hook for authentication state with session timeout handling
 *
 * Wrap your app with AuthProvider, then use useAuth() in components.
 *
 * MedRock Auth Integration Package 1.3.0 — canonical (direct) flow.
 * Calls the auth host directly with `credentials: 'include'`; the shared
 * `.medrockpharmacy.com` session cookie travels cross-origin, so no local
 * proxy routes are needed. (This app previously forked to a /api/auth/* proxy
 * to work around cross-origin cookies; the auth host now supports CORS +
 * /api/extend-session directly, so we're back on the canonical package.)
 *
 * Features:
 * - Initial user fetch via /api/me
 * - Proactive session timeout modal scheduled against the server-reported
 *   `expires_at` (no polling/heartbeat for the primary trigger)
 * - "Stay Signed In" calls /api/extend-session, which cookie-refreshes server-side
 * - Tab visibility handling: when a tab becomes visible we re-fetch /api/me to
 *   pick up any expiry advance done by another tab (and to schedule the timer
 *   in this tab)
 * - Safety-net heartbeat that fires only if expires_at was unavailable (e.g.,
 *   older cookies that didn't include it)
 */

'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { SessionTimeoutModal } from '@/components/SessionTimeoutModal';
import type { User } from '@/lib/auth-client';

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';

// Configuration
const FALLBACK_HEARTBEAT_INTERVAL_MS = 60 * 1000; // Only used when expires_at is unknown
const TIMEOUT_WARNING_SECONDS = 60; // Show the modal this many seconds before token expiry

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
  success?: boolean;
  user?: User;
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

  // Check session by calling /api/me. Returns true if session is valid.
  // Also captures expires_at so the warning modal can be scheduled proactively.
  const checkSession = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(`${AUTH_SERVICE_URL}/api/me`, {
        credentials: 'include',
      });

      if (response.ok) {
        const data = (await response.json()) as MeResponse;
        if (data.user) setUser(data.user);
        if (typeof data.expires_at === 'number') {
          setExpiresAt(data.expires_at);
        } else {
          setExpiresAt(null);
        }
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

  // Try to refresh/extend the session via the auth host's cookie-based refresh endpoint.
  const extendSession = useCallback(async (): Promise<boolean> => {
    try {
      const refreshResp = await fetch(`${AUTH_SERVICE_URL}/api/extend-session`, {
        method: 'POST',
        credentials: 'include',
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

      // Refresh truly failed. Try one more /api/me in case the underlying issue
      // was a transient network blip rather than a dead refresh token.
      const stillValid = await checkSession();
      return stillValid;
    } catch (err) {
      console.error('Session extend failed:', err);
      return false;
    }
  }, [checkSession]);

  // Initial user fetch
  const fetchUser = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch(`${AUTH_SERVICE_URL}/api/me`, {
        credentials: 'include',
      });

      if (response.ok) {
        const data = (await response.json()) as MeResponse;
        if (data.user) setUser(data.user);
        if (typeof data.expires_at === 'number') {
          setExpiresAt(data.expires_at);
        }
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

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  // Primary modal trigger: schedule it to fire `timeoutWarningSeconds` before token expiry.
  // This avoids the old failure-driven model where the modal only appeared *after* /api/me
  // had already 401'd — by which point refresh was usually also dead.
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

  // Safety-net heartbeat: ONLY active when expires_at is unknown (older auth host or
  // legacy cookie format). With expires_at the scheduled timeout above handles things.
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
