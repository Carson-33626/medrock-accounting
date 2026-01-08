'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useAuth } from '@/lib/use-auth';

interface ConnectionStatus {
  connected: boolean;
  location?: string;
  lastSyncAt?: number;
  companyName?: string;
  isExpired?: boolean;
}

interface QuickBooksStatusIndicatorProps {
  location: string; // Current location being viewed
}

export function QuickBooksStatusIndicator({ location }: QuickBooksStatusIndicatorProps) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  useEffect(() => {
    const fetchStatus = async () => {
      if (location === 'all') {
        setStatus({ connected: false });
        setLoading(false);
        return;
      }

      try {
        const response = await fetch('/api/quickbooks/status');
        if (!response.ok) {
          throw new Error('Failed to fetch status');
        }

        const data = await response.json();
        const locationStatus = data.details[location];

        if (locationStatus && locationStatus.connected) {
          // Check if token is expired
          const now = Date.now();
          const isExpired = locationStatus.expiresAt && locationStatus.expiresAt < now;

          setStatus({
            connected: true,
            location,
            lastSyncAt: Date.now(), // In a real implementation, this would come from API
            companyName: locationStatus.companyName,
            isExpired,
          });
        } else {
          setStatus({ connected: false, location });
        }
      } catch (error) {
        console.error('Failed to fetch QB status:', error);
        setStatus({ connected: false, location });
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
  }, [location]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Checking QuickBooks status...</span>
      </div>
    );
  }

  if (!status || location === 'all') {
    return null;
  }

  const formatLastSync = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  if (!status.connected) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg">
        <XCircle className="h-4 w-4 text-gray-400 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            QuickBooks not connected
          </p>
          {isAdmin && (
            <Link
              href="/admin/quickbooks"
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              Connect now →
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (status.isExpired) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-800 rounded-lg">
        <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm text-yellow-800 dark:text-yellow-200 font-medium">
            QuickBooks connection expired
          </p>
          {isAdmin && (
            <Link
              href="/admin/quickbooks"
              className="text-xs text-yellow-900 dark:text-yellow-300 hover:underline"
            >
              Reconnect now →
            </Link>
          )}
          {!isAdmin && (
            <p className="text-xs text-yellow-700 dark:text-yellow-300">
              Contact admin to reconnect
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-800 rounded-lg">
      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0" />
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm text-green-800 dark:text-green-200 font-medium">
            QuickBooks connected
          </p>
          <span className="text-xs text-green-700 dark:text-green-300">
            {status.companyName}
          </span>
        </div>
        {status.lastSyncAt && (
          <p className="text-xs text-green-700 dark:text-green-300">
            Last synced {formatLastSync(status.lastSyncAt)}
          </p>
        )}
      </div>
      {isAdmin && (
        <Link
          href="/admin/quickbooks"
          title="Manage QuickBooks connections"
          className="text-green-700 dark:text-green-300 hover:text-green-900 dark:hover:text-green-100 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}
