'use client';

import { useEffect, useState, useCallback } from 'react';

interface SessionTimeoutModalProps {
  /** Seconds until auto-logout (default: 60) */
  timeoutSeconds?: number;
  /** Called when user clicks "Stay Signed In" */
  onExtend: () => Promise<boolean>;
  /** Called when user clicks "Log Out" or countdown expires */
  onLogout: () => void;
  /** Called when modal should be dismissed (after successful extend) */
  onDismiss: () => void;
}

export function SessionTimeoutModal({
  timeoutSeconds = 60,
  onExtend,
  onLogout,
  onDismiss,
}: SessionTimeoutModalProps) {
  const [countdown, setCountdown] = useState(timeoutSeconds);
  const [extending, setExtending] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) {
      onLogout();
      return;
    }

    const timer = setInterval(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [countdown, onLogout]);

  const handleExtend = useCallback(async () => {
    setExtending(true);
    setRefreshError(null);
    try {
      const success = await onExtend();
      if (success) {
        onDismiss();
      } else {
        // Refresh failed, show error but don't log out automatically
        setRefreshError('Session refresh failed. Please try again or log in manually.');
      }
    } catch {
      setRefreshError('Session refresh failed. Please try again or log in manually.');
    } finally {
      setExtending(false);
    }
  }, [onExtend, onDismiss]);

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

        {/* Error message if refresh failed */}
        {refreshError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-800 text-center">{refreshError}</p>
          </div>
        )}

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
            {extending ? 'Refreshing...' : (refreshError ? 'Try Again' : 'Refresh Session')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SessionTimeoutModal;
