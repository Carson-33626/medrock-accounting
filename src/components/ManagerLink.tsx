/**
 * ManagerLink Component
 *
 * Shows a manager dashboard link for the manager tier — role `'admin'` or `'super_admin'`.
 * Include this in your sidebar, header, or user menu.
 *
 * ⚠️ Tier reminder: the role string `'admin'` is the MANAGER tier. The admin dashboard
 * is gated on `'super_admin'` — see AdminLink for that.
 */

'use client';

import React from 'react';
import { useAuth } from '@/lib/use-auth';
import { authClient } from '@/lib/auth-client';

interface ManagerLinkProps {
  /** Custom class name for styling */
  className?: string;
  /** Show as icon only (no text) */
  iconOnly?: boolean;
  /** Custom label text */
  label?: string;
  /** Custom icon (React node) */
  icon?: React.ReactNode;
}

/**
 * Default manager icon (people)
 */
function DefaultManagerIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
      />
    </svg>
  );
}

/**
 * ManagerLink - Only renders for the manager tier (role 'admin' or 'super_admin')
 *
 * Usage:
 * ```tsx
 * // In your sidebar or header
 * <ManagerLink />
 *
 * // With custom styling
 * <ManagerLink className="text-blue-600 hover:text-blue-800" />
 *
 * // Icon only (for compact headers)
 * <ManagerLink iconOnly />
 *
 * // Custom label
 * <ManagerLink label="My Team" />
 * ```
 */
export function ManagerLink({
  className = "flex items-center gap-2 text-gray-600 hover:text-gray-900",
  iconOnly = false,
  label = "Manager Dashboard",
  icon,
}: ManagerLinkProps) {
  const { user, loading } = useAuth();

  // Don't render anything if loading or the user is below the manager tier
  if (loading || !authClient.isManager(user)) {
    return null;
  }

  const managerUrl = authClient.getManagerUrl();
  const iconElement = icon || <DefaultManagerIcon />;

  if (iconOnly) {
    return (
      <a
        href={managerUrl}
        className={className}
        title={label}
        aria-label={label}
      >
        {iconElement}
      </a>
    );
  }

  return (
    <a href={managerUrl} className={className}>
      {iconElement}
      <span>{label}</span>
    </a>
  );
}

/**
 * useIsManager hook - Check if the current user is in the manager tier
 *
 * Usage:
 * ```tsx
 * const { isManager, loading } = useIsManager();
 * ```
 */
export function useIsManager() {
  const { user, loading } = useAuth();

  return {
    isManager: authClient.isManager(user),
    isSuperAdmin: authClient.isSuperAdmin(user),
    loading,
    user,
  };
}
