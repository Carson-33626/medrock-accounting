/**
 * React hook for authentication state with session timeout handling
 *
 * Wrap your app with AuthProvider, then use useAuth() in components.
 *
 * Features:
 * - Automatic session validation (heartbeat every 60s)
 * - Session timeout warning modal (ADP-style)
 * - Silent session refresh when possible
 * - Tab visibility handling (checks session when tab becomes active)
 */

'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { SessionTimeoutModal } from '@/components/SessionTimeoutModal';

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';

// Configuration
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // Check session every 60 seconds
const TIMEOUT_WARNING_SECONDS = 60; // Show warning with 60 second countdown

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
  login: (redirectUrl?: string) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  extendSession: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
  /** Disable session heartbeat (for testing) */
  disableHeartbeat?: boolean;
  /** Custom timeout warning duration in seconds (default: 60) */
  timeoutWarningSeconds?: number;
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

  // Track if we've already shown the warning for this session check
  const warningShownRef = useRef(false);

  // Check session by calling /api/me
  const checkSession = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(`${AUTH_SERVICE_URL}/api/me`, {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        setSessionExpired(false);
        return true;
      } else {
        // Session invalid
        return false;
      }
    } catch (err) {
      console.error('Session check failed:', err);
      return false;
    }
  }, []);

  // Try to refresh/extend the session
  const extendSession = useCallback(async (): Promise<boolean> => {
    try {
      // First, try to check if session is still valid
      const isValid = await checkSession();
      if (isValid) {
        return true;
      }

      // Session check failed - in a cookie-based SSO setup,
      // if /api/me fails, the session is truly expired
      // The refresh would need to happen server-side
      // For now, we return false to trigger re-login
      return false;
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
        const data = await response.json();
        setUser(data.user);
      } else {
        setUser(null);
      }
    } catch (err) {
      console.error('Failed to fetch user:', err);
      setError('Failed to check authentication');
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load user on mount
  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  // Session heartbeat - checks session periodically and on tab focus
  useEffect(() => {
    if (disableHeartbeat || !user) return;

    const performHeartbeat = async () => {
      const isValid = await checkSession();

      if (!isValid && !warningShownRef.current) {
        // Session expired, show timeout warning
        warningShownRef.current = true;
        setShowTimeoutWarning(true);
      }
    };

    // Run heartbeat on interval
    const interval = setInterval(performHeartbeat, HEARTBEAT_INTERVAL_MS);

    // Also check when tab becomes visible (user returns to tab)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        performHeartbeat();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
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
    const success = await extendSession();
    if (success) {
      warningShownRef.current = false;
    }
    return success;
  }, [extendSession]);

  const handleDismissModal = useCallback(() => {
    setShowTimeoutWarning(false);
    warningShownRef.current = false;
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
