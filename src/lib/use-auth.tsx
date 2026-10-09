/**
 * React hook for authentication state with session timeout handling
 *
 * Wrap your app with AuthProvider, then use useAuth() in components.
 *
 * Session rules (1.9.0, enforced by the auth host):
 * - 15 minutes without user activity ends the session; 12 hours ends it regardless.
 * - Activity = real input (pointer, keys, touch, wheel, actual mouse movement), page
 *   navigation, "Stay Signed In". This provider reports input with a throttled
 *   POST /api/activity (at most once a minute).
 * - /api/me is read-only for the idle clock, so tab-visible re-checks and the modal's
 *   countdown-0 check can never keep an unattended session alive.
 * - The warning modal is scheduled against the server's `idle_expires_at`, which activity in
 *   ANY tab or MedRock app moves. Before showing it we re-read /api/me to catch that.
 *   Deadlines are in server time; `server_time_ms` corrects for this machine's clock skew.
 * - Only the server ends a session. A network error or 5xx never logs anyone out — the
 *   provider retries. An idle logout does not call /api/logout (the server already ended
 *   that one session; /api/logout would sign the user out on every device).
 * - Access tokens refresh silently while the session is active (a /api/me shortly before
 *   `expires_at`); token expiry is never shown to the user.
 *
 * Backward compatible with an auth host that predates idle enforcement: if /api/me returns
 * no `idle_expires_at`, the modal falls back to the 1.8.1 token-expiry schedule. Activity
 * pings to an old host fail (no CORS on the 404) and are ignored; they start working the
 * moment the host ships, with no reload.
 */

'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { SessionTimeoutModal } from '@/components/SessionTimeoutModal';
import type { User } from '@/lib/auth-client';

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';

// Configuration
const FALLBACK_HEARTBEAT_INTERVAL_MS = 60 * 1000; // Legacy only: expires_at unknown
const TIMEOUT_WARNING_SECONDS = 60; // Show the modal this many seconds before the deadline
const ACTIVITY_PING_INTERVAL_MS = 60 * 1000; // At most one activity ping per minute
const TOKEN_REFRESH_LEAD_SECONDS = 120; // Silent /api/me this long before the token expires
const EXPIRE_RECHECK_MS = 3000; // Countdown 0 with no verdict yet: ask the server again
// No 'scroll' (it fires for programmatic scrolling too) — wheel/touch/keys cover users.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export type SessionEndReason = 'idle' | 'ceiling';

/**
 * active  = signed in
 * ended   = the server ended it (401 SESSION_IDLE / SESSION_CEILING)
 * invalid = other 401 (no session / dead refresh token)
 * error   = network failure or 5xx — never a reason to log out
 */
type SessionCheck = 'active' | 'ended' | 'invalid' | 'error';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  sessionExpired: boolean;
  /** Unix timestamp (seconds) of current access token expiry, or null if unknown */
  expiresAt: number | null;
  /** Unix timestamp (seconds, server clock) the idle window closes, or null on an older auth host */
  idleExpiresAt: number | null;
  login: (redirectUrl?: string) => void;
  logout: (reason?: SessionEndReason) => Promise<void>;
  refreshUser: () => Promise<void>;
  extendSession: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
  /** Disable session heartbeat / scheduling / activity pings (for testing) */
  disableHeartbeat?: boolean;
  /** Show the warning modal this many seconds before the deadline (default: 60) */
  timeoutWarningSeconds?: number;
}

interface SessionInfo {
  expires_at?: number | null;
  idle_expires_at?: number | null;
  server_time_ms?: number | null;
}

interface MeResponse extends SessionInfo {
  success?: boolean;
  user?: User;
}

interface ErrorResponse {
  error?: { code?: string };
}

async function readEndReason(response: Response): Promise<SessionEndReason | null> {
  try {
    const body = (await response.json()) as ErrorResponse;
    if (body.error?.code === 'SESSION_IDLE') return 'idle';
    if (body.error?.code === 'SESSION_CEILING') return 'ceiling';
    return null;
  } catch {
    return null;
  }
}

function sameUser(a: User | null, b: User): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
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
  const [idleExpiresAt, setIdleExpiresAt] = useState<number | null>(null);
  // Effects key on the user's id, not the object: /api/me returns a fresh object every call.
  const userId = user?.id ?? null;

  const expiresAtRef = useRef(expiresAt);
  const idleExpiresAtRef = useRef(idleExpiresAt);
  const showWarningRef = useRef(showTimeoutWarning);
  // server clock − this machine's clock, in ms. Deadlines arrive in server time.
  const clockOffsetMsRef = useRef(0);
  useEffect(() => {
    expiresAtRef.current = expiresAt;
    idleExpiresAtRef.current = idleExpiresAt;
    showWarningRef.current = showTimeoutWarning;
  }, [expiresAt, idleExpiresAt, showTimeoutWarning]);

  /** A server-time deadline (unix seconds) as a local Date.now()-comparable ms value. */
  const toLocalMs = useCallback((serverSeconds: number) => serverSeconds * 1000 - clockOffsetMsRef.current, []);

  const applySessionInfo = useCallback((data: SessionInfo) => {
    if (typeof data.server_time_ms === 'number') {
      clockOffsetMsRef.current = data.server_time_ms - Date.now();
    }
    const nextExpires = typeof data.expires_at === 'number' ? data.expires_at : null;
    const nextIdle = typeof data.idle_expires_at === 'number' ? data.idle_expires_at : null;
    // Update the refs synchronously so callers can compare right after an await.
    expiresAtRef.current = nextExpires;
    idleExpiresAtRef.current = nextIdle;
    setExpiresAt(nextExpires);
    setIdleExpiresAt(nextIdle);
  }, []);

  const applyUser = useCallback((next: User) => {
    setUser((prev) => (sameUser(prev, next) ? prev : next));
  }, []);

  // `reason` = the SERVER ended this session (idle / ceiling) and already revoked it and
  // cleared the cookie, so skip /api/logout: it signs the user out on every device.
  const logout = useCallback(async (reason?: SessionEndReason) => {
    if (!reason) {
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
    }

    setUser(null);
    setExpiresAt(null);
    setIdleExpiresAt(null);
    setSessionExpired(true);
    setShowTimeoutWarning(false);
    const reasonParam = reason ? `&reason=${reason}` : '';
    window.location.href = `${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(window.location.origin)}${reasonParam}`;
  }, []);

  // Read /api/me. Never extends the idle window; refreshes the token while active.
  const checkSession = useCallback(async (): Promise<SessionCheck> => {
    try {
      const response = await fetch(`${AUTH_SERVICE_URL}/api/me`, {
        credentials: 'include',
      });

      if (response.ok) {
        const data = (await response.json()) as MeResponse;
        if (data.user) applyUser(data.user);
        applySessionInfo(data);
        setSessionExpired(false);
        return 'active';
      }
      if (response.status !== 401) return 'error';
      return (await readEndReason(response)) ? 'ended' : 'invalid';
    } catch (err) {
      console.error('Session check failed:', err);
      return 'error';
    }
  }, [applySessionInfo, applyUser]);

  // Act on a check result: only the server's word ends a session; errors are retried.
  const handleCheckResult = useCallback(
    async (result: SessionCheck) => {
      if (result === 'ended') await logout('idle');
      else if (result === 'invalid') await logout();
    },
    [logout]
  );

  // "Stay Signed In": records activity and rotates the tokens.
  const extendSession = useCallback(async (): Promise<boolean> => {
    try {
      const refreshResp = await fetch(`${AUTH_SERVICE_URL}/api/extend-session`, {
        method: 'POST',
        credentials: 'include',
      });

      if (refreshResp.ok) {
        // Re-fetch so user, expires_at and idle_expires_at are all consistent.
        return (await checkSession()) === 'active';
      }
      if (await readEndReason(refreshResp)) return false;

      // Refresh failed for another reason. One more /api/me in case it was a blip.
      return (await checkSession()) === 'active';
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
        if (data.user) applyUser(data.user);
        applySessionInfo(data);
      } else {
        setUser(null);
        applySessionInfo({});
      }
    } catch (err) {
      console.error('Failed to fetch user:', err);
      setError('Failed to check authentication');
      setUser(null);
      applySessionInfo({});
    } finally {
      setLoading(false);
    }
  }, [applySessionInfo, applyUser]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  // ── Activity pings ─────────────────────────────────────────────────────────
  // Real input → POST /api/activity, at most once a minute. Suppressed while the modal is
  // open: only "Stay Signed In" may dismiss it. Input the throttle held back is flushed on
  // pagehide with sendBeacon (`?beacon=1`: the server records it without rotating tokens).
  useEffect(() => {
    if (disableHeartbeat || !userId) return;

    let lastPingMs = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let unsentInput = false;
    let lastPointer: { x: number; y: number } | null = null;

    const ping = async () => {
      pending = null;
      unsentInput = false;
      lastPingMs = Date.now();
      try {
        const response = await fetch(`${AUTH_SERVICE_URL}/api/activity`, {
          method: 'POST',
          credentials: 'include',
        });
        if (response.ok) {
          applySessionInfo((await response.json()) as SessionInfo);
        } else if (response.status === 401) {
          const reason = await readEndReason(response);
          if (reason) await logout(reason);
        }
      } catch {
        // Network blip, or an auth host that predates /api/activity: the next input retries.
      }
    };

    const onInput = () => {
      if (showWarningRef.current) return;
      const sinceLast = Date.now() - lastPingMs;
      if (sinceLast >= ACTIVITY_PING_INTERVAL_MS) {
        void ping();
      } else {
        unsentInput = true;
        if (!pending) pending = setTimeout(() => void ping(), ACTIVITY_PING_INTERVAL_MS - sinceLast);
      }
    };

    // Browsers fire mousemove when content moves under a parked cursor; count only real moves.
    const onMouseMove = (event: MouseEvent) => {
      const moved = lastPointer === null || lastPointer.x !== event.screenX || lastPointer.y !== event.screenY;
      lastPointer = { x: event.screenX, y: event.screenY };
      if (moved) onInput();
    };

    const onPageHide = () => {
      if (unsentInput && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(`${AUTH_SERVICE_URL}/api/activity?beacon=1`);
      }
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onInput, { passive: true, capture: true });
    }
    window.addEventListener('mousemove', onMouseMove, { passive: true, capture: true });
    window.addEventListener('pagehide', onPageHide);

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onInput, { capture: true });
      }
      window.removeEventListener('mousemove', onMouseMove, { capture: true });
      window.removeEventListener('pagehide', onPageHide);
      if (pending) clearTimeout(pending);
    };
  }, [userId, disableHeartbeat, applySessionInfo, logout]);

  // ── Idle warning (auth host with idle enforcement) ─────────────────────────
  // Fires `timeoutWarningSeconds` before idle_expires_at. Another tab or app may have
  // recorded activity since, so re-read /api/me first: a moved deadline re-runs this effect
  // and reschedules; otherwise (unchanged, or the check failed) the modal opens.
  useEffect(() => {
    if (disableHeartbeat || !userId || idleExpiresAt === null) return;

    const msUntilWarning = toLocalMs(idleExpiresAt) - timeoutWarningSeconds * 1000 - Date.now();
    if (msUntilWarning <= 0) {
      setShowTimeoutWarning(true);
      return;
    }

    setShowTimeoutWarning(false);
    const timer = setTimeout(async () => {
      const before = idleExpiresAtRef.current;
      const result = await checkSession();
      if (result === 'ended' || result === 'invalid') {
        await handleCheckResult(result);
      } else if (idleExpiresAtRef.current === before) {
        setShowTimeoutWarning(true);
      }
    }, msUntilWarning);
    return () => clearTimeout(timer);
  }, [userId, idleExpiresAt, timeoutWarningSeconds, disableHeartbeat, checkSession, handleCheckResult, toLocalMs]);

  // Silent token refresh while active: /api/me shortly before the access token expires.
  // The server refuses it once the session is idle, so this cannot keep anyone signed in.
  useEffect(() => {
    if (disableHeartbeat || !userId || idleExpiresAt === null || expiresAt === null) return;

    const msUntilRefresh = (expiresAt - TOKEN_REFRESH_LEAD_SECONDS) * 1000 - clockOffsetMsRef.current - Date.now();
    const timer = setTimeout(async () => {
      await handleCheckResult(await checkSession());
    }, Math.max(msUntilRefresh, 0));
    return () => clearTimeout(timer);
  }, [userId, expiresAt, idleExpiresAt, disableHeartbeat, checkSession, handleCheckResult]);

  // ── Legacy schedule (auth host without idle enforcement) ───────────────────
  // Unchanged from 1.8.1: modal `timeoutWarningSeconds` before token expiry.
  useEffect(() => {
    if (disableHeartbeat) return;
    if (!userId || !expiresAt || idleExpiresAt !== null) return;

    const msUntilWarning = expiresAt * 1000 - timeoutWarningSeconds * 1000 - Date.now();
    if (msUntilWarning <= 0) {
      setShowTimeoutWarning(true);
      return;
    }

    setShowTimeoutWarning(false);
    const timer = setTimeout(() => {
      setShowTimeoutWarning(true);
    }, msUntilWarning);

    return () => clearTimeout(timer);
  }, [userId, expiresAt, idleExpiresAt, timeoutWarningSeconds, disableHeartbeat]);

  // Tab re-focus: re-read /api/me (read-only) to pick up activity from other tabs/apps — or
  // to find the session already ended while the tab was hidden. Plus a legacy poll-on-401
  // fallback only when neither deadline is known.
  useEffect(() => {
    if (disableHeartbeat || !userId) return;

    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;
      await handleCheckResult(await checkSession());
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    let interval: ReturnType<typeof setInterval> | null = null;
    if (expiresAtRef.current === null && idleExpiresAtRef.current === null) {
      interval = setInterval(async () => {
        const result = await checkSession();
        if (result !== 'active') setShowTimeoutWarning(true);
      }, FALLBACK_HEARTBEAT_INTERVAL_MS);
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (interval) clearInterval(interval);
    };
  }, [userId, disableHeartbeat, checkSession, handleCheckResult]);

  const login = useCallback((redirectUrl?: string) => {
    const redirect = redirectUrl || window.location.href;
    window.location.href = `${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(redirect)}`;
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
    void logout();
  }, [logout]);

  // Countdown reached the deadline. In idle mode /api/me cannot revive the session: the
  // server either says it ended (→ logout), or reports activity that really happened
  // elsewhere (the moved idle_expires_at closes the modal). With no verdict yet — a network
  // error, or a residual clock difference — ask again shortly; the modal stays at 0 and
  // its buttons keep working. Legacy mode: /api/me may still refresh, exactly as in 1.8.1.
  const expireRecheckRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (expireRecheckRef.current) clearTimeout(expireRecheckRef.current);
  }, []);
  const handleExpireFromModal = useCallback(async () => {
    const result = await checkSession();
    if (result === 'ended' || result === 'invalid') {
      await handleCheckResult(result);
      return;
    }
    const idleNow = idleExpiresAtRef.current;
    const deadlinePassed = idleNow !== null && toLocalMs(idleNow) <= Date.now();
    if (result === 'error' || deadlinePassed) {
      expireRecheckRef.current = setTimeout(() => void handleExpireFromModal(), EXPIRE_RECHECK_MS);
    }
  }, [checkSession, handleCheckResult, toLocalMs]);

  // Legacy cookies (no expires_at) only reach the modal after /api/me already
  // failed, so they get the old grace window from when the modal opens.
  const [legacyDeadlineMs, setLegacyDeadlineMs] = useState<number | null>(null);
  useEffect(() => {
    setLegacyDeadlineMs(
      showTimeoutWarning && !expiresAt && !idleExpiresAt ? Date.now() + timeoutWarningSeconds * 1000 : null
    );
  }, [showTimeoutWarning, expiresAt, idleExpiresAt, timeoutWarningSeconds]);
  const deadlineMs = idleExpiresAt ? toLocalMs(idleExpiresAt) : expiresAt ? expiresAt * 1000 : legacyDeadlineMs;

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        sessionExpired,
        expiresAt,
        idleExpiresAt,
        login,
        logout,
        refreshUser,
        extendSession,
      }}
    >
      {children}

      {showTimeoutWarning && deadlineMs !== null && (
        <SessionTimeoutModal
          key={idleExpiresAt ?? deadlineMs}
          deadlineMs={deadlineMs}
          onExtend={handleExtendFromModal}
          onExpire={() => void handleExpireFromModal()}
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
