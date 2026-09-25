'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface SessionTimeoutModalProps {
  /** Wall-clock deadline (ms since epoch) — the access token's real expiry. */
  deadlineMs: number;
  /** Called when user clicks "Stay Signed In" */
  onExtend: () => Promise<boolean>;
  /** Deadline reached (page visible): try a silent revive, else log out. Called at most once. */
  onExpire: () => void;
  /** Called when user clicks "Log Out" */
  onLogout: () => void;
  /** Called when modal should be dismissed (after successful extend) */
  onDismiss: () => void;
}

function secondsLeft(deadlineMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
}

export function SessionTimeoutModal({
  deadlineMs,
  onExtend,
  onExpire,
  onLogout,
  onDismiss,
}: SessionTimeoutModalProps) {
  // Derived from the real expiry, never a private counter: a counter pauses/throttles
  // while the tab is hidden, so after time away it showed time the session no longer had.
  const [countdown, setCountdown] = useState(() => secondsLeft(deadlineMs));
  const [extending, setExtending] = useState(false);
  const expiredRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    const tick = () => {
      const left = secondsLeft(deadlineMs);
      setCountdown(left);
      // Only act on expiry while the user can see the page — a hidden tab waits
      // until it's shown (the visibilitychange tick), then onExpire revives or logs out.
      if (left === 0 && !expiredRef.current && document.visibilityState === 'visible') {
        expiredRef.current = true;
        onExpireRef.current();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    // Background tabs throttle intervals; resync the moment the tab is shown.
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [deadlineMs]);

  const handleExtend = useCallback(async () => {
    setExtending(true);
    try {
      const success = await onExtend();
      if (success) {
        onDismiss();
      } else {
        // Refresh failed, log out
        onLogout();
      }
    } catch {
      onLogout();
    } finally {
      setExtending(false);
    }
  }, [onExtend, onDismiss, onLogout]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    return `${secs} seconds`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6 animate-in fade-in zoom-in duration-200">
        {/* Icon */}
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center">
            <svg
              className="w-8 h-8 text-amber-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
        </div>

        {/* Title */}
        <h2 className="text-xl font-semibold text-gray-900 text-center mb-2">
          Session Timeout
        </h2>

        {/* Message */}
        <p className="text-gray-600 text-center mb-4">
          Your session is about to expire due to inactivity.
        </p>

        {/* Countdown */}
        <div className="text-center mb-6">
          <span className="text-sm text-gray-500">You will be logged out in</span>
          <div
            className={`text-3xl font-mono font-bold mt-1 ${
              countdown <= 10 ? 'text-red-600' : 'text-amber-600'
            }`}
          >
            {formatTime(countdown)}
          </div>
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={onLogout}
            disabled={extending}
            className="flex-1 px-4 py-3 border-2 border-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            Log Out
          </button>
          <button
            onClick={handleExtend}
            disabled={extending}
            className="flex-1 px-4 py-3 bg-purple-600 text-white rounded-xl font-medium hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-wait"
          >
            {extending ? 'Extending...' : 'Stay Signed In'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SessionTimeoutModal;
