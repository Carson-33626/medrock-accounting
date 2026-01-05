/**
 * AdminLink Component
 *
 * Shows an admin dashboard link only for super_admin users.
 * Include this in your sidebar, header, or user menu.
 */

'use client';

import React from 'react';
import { useAuth } from '@/lib/use-auth';
import { authClient } from '@/lib/auth-client';

interface AdminLinkProps {
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
 * Default admin icon (gear/cog)
 */
function DefaultAdminIcon({ className = "w-5 h-5" }: { className?: string }) {
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
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  );
}

/**
 * AdminLink - Only renders for super_admin users
 *
 * Usage:
 * ```tsx
 * // In your sidebar or header
 * <AdminLink />
 *
 * // With custom styling
 * <AdminLink className="text-purple-600 hover:text-purple-800" />
 *
 * // Icon only (for compact headers)
 * <AdminLink iconOnly />
 *
 * // Custom label
 * <AdminLink label="Manage Access" />
 * ```
 */
export function AdminLink({
  className = "flex items-center gap-2 text-gray-600 hover:text-gray-900",
  iconOnly = false,
  label = "Admin Dashboard",
  icon,
}: AdminLinkProps) {
  const { user, loading } = useAuth();

  // Don't render anything if loading or user is not a super_admin
  if (loading || !authClient.isSuperAdmin(user)) {
    return null;
  }

  const adminUrl = authClient.getAdminUrl();
  const iconElement = icon || <DefaultAdminIcon />;

  if (iconOnly) {
    return (
      <a
        href={adminUrl}
        className={className}
        title={label}
        aria-label={label}
      >
        {iconElement}
      </a>
    );
  }

  return (
    <a href={adminUrl} className={className}>
      {iconElement}
      <span>{label}</span>
    </a>
  );
}

/**
 * useIsAdmin hook - Check if current user is an admin
 *
 * Usage:
 * ```tsx
 * const { isAdmin, isSuperAdmin, loading } = useIsAdmin();
 *
 * if (isSuperAdmin) {
 *   // Show admin features
 * }
 * ```
 */
export function useIsAdmin() {
  const { user, loading } = useAuth();

  return {
    isAdmin: authClient.isAdmin(user),
    isSuperAdmin: authClient.isSuperAdmin(user),
    loading,
    user,
  };
}
