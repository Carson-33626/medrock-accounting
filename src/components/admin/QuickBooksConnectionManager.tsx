'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, ExternalLink, Loader2, AlertTriangle } from 'lucide-react';

interface LocationStatus {
  connected: boolean;
  realmId: string | null;
  companyName: string | null;
  expiresAt: number | null;
}

interface ConnectionStatus {
  status: Record<string, boolean>;
  details: Record<string, LocationStatus>;
}

const LOCATIONS = [
  { key: 'MedRock FL', name: 'Florida', qbCompany: 'Medrock FLORIDA' },
  { key: 'MedRock TN', name: 'Tennessee', qbCompany: 'Medrock TENNESSEE' },
  { key: 'MedRock TX', name: 'Texas', qbCompany: 'Medrock TEXAS' },
] as const;

export function QuickBooksConnectionManager() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/quickbooks/status');

      if (!response.ok) {
        throw new Error('Failed to fetch connection status');
      }

      const data = await response.json();
      setConnectionStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();

    // Check for success/error in URL params
    const params = new URLSearchParams(window.location.search);
    const success = params.get('success');
    const location = params.get('location');
    const errorParam = params.get('error');

    if (success === 'true' && location) {
      setSuccessMessage(`Successfully connected QuickBooks for ${location}!`);
      // Clear URL params
      window.history.replaceState({}, '', window.location.pathname);
      // Refresh status after connection
      setTimeout(fetchStatus, 500);
    } else if (errorParam) {
      setError(`Connection failed: ${errorParam}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const handleConnect = (location: string) => {
    // Redirect to API route that generates QB OAuth URL
    window.location.href = `/api/quickbooks/authorize?location=${encodeURIComponent(location)}`;
  };

  const handleDisconnect = async (location: string) => {
    if (!confirm(`Are you sure you want to disconnect QuickBooks for ${location}? This will remove all stored tokens.`)) {
      return;
    }

    try {
      setDisconnecting(location);
      const response = await fetch(`/api/quickbooks/disconnect?location=${encodeURIComponent(location)}`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to disconnect');
      }

      setSuccessMessage(`Successfully disconnected ${location}`);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setDisconnecting(null);
    }
  };

  const formatExpiration = (timestamp: number | null): string => {
    if (!timestamp) return 'Unknown';

    const expiresAt = new Date(timestamp);
    const now = new Date();
    const diffMs = expiresAt.getTime() - now.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 0) return 'Expired';
    if (diffMins < 60) return `${diffMins} minutes`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hours`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} days`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error && !connectionStatus) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
        <div className="flex items-center gap-3 text-red-800 dark:text-red-200">
          <AlertTriangle className="h-5 w-5" />
          <p>{error}</p>
        </div>
        <button
          onClick={fetchStatus}
          className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Success/Error messages */}
      {successMessage && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
          <div className="flex items-center gap-3 text-green-800 dark:text-green-200">
            <CheckCircle2 className="h-5 w-5" />
            <p>{successMessage}</p>
            <button
              onClick={() => setSuccessMessage(null)}
              className="ml-auto text-sm hover:underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <div className="flex items-center gap-3 text-red-800 dark:text-red-200">
            <AlertTriangle className="h-5 w-5" />
            <p>{error}</p>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-sm hover:underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Location connection cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {LOCATIONS.map((location) => {
          const status = connectionStatus?.details[location.key];
          const isConnected = status?.connected || false;
          const isDisconnecting = disconnecting === location.key;

          return (
            <div
              key={location.key}
              className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg p-6 shadow-sm"
            >
              {/* Header with status indicator */}
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {location.name}
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
                    {location.qbCompany}
                  </p>
                </div>
                {isConnected ? (
                  <CheckCircle2 className="h-6 w-6 text-green-500 flex-shrink-0" />
                ) : (
                  <XCircle className="h-6 w-6 text-gray-400 flex-shrink-0" />
                )}
              </div>

              {/* Connection details */}
              {isConnected && status ? (
                <div className="space-y-2 mb-4 text-sm">
                  {status.companyName && (
                    <div>
                      <span className="text-gray-500 dark:text-slate-400">Company: </span>
                      <span className="text-gray-900 dark:text-white font-medium">
                        {status.companyName}
                      </span>
                    </div>
                  )}
                  {status.realmId && (
                    <div>
                      <span className="text-gray-500 dark:text-slate-400">Realm ID: </span>
                      <span className="text-gray-900 dark:text-white font-mono text-xs">
                        {status.realmId}
                      </span>
                    </div>
                  )}
                  <div>
                    <span className="text-gray-500 dark:text-slate-400">Token expires: </span>
                    <span className="text-gray-900 dark:text-white">
                      {formatExpiration(status.expiresAt)}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">
                  Not connected to QuickBooks
                </p>
              )}

              {/* Actions */}
              {isConnected ? (
                <button
                  onClick={() => handleDisconnect(location.key)}
                  disabled={isDisconnecting}
                  className="w-full px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isDisconnecting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Disconnecting...
                    </>
                  ) : (
                    'Disconnect'
                  )}
                </button>
              ) : (
                <button
                  onClick={() => handleConnect(location.key)}
                  className="w-full px-4 py-2 text-white rounded-lg font-medium transition-colors hover:opacity-90 flex items-center justify-center gap-2"
                  style={{ backgroundColor: '#5e3b8d' }}
                >
                  <ExternalLink className="h-4 w-4" />
                  Connect QuickBooks
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
