'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * An error or warning banner with a close button. The message stays until the
 * reader dismisses it or the next action replaces it. Carson, 2026-09-15: "I need
 * an X on the error banners so they go away after i read them."
 *
 * Dismissing only clears the message from view (the caller resets its state);
 * nothing is retried or undone.
 */
export function DismissibleBanner({
  tone,
  darkMode,
  onDismiss,
  children,
}: {
  tone: 'error' | 'warning';
  darkMode: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const palette =
    tone === 'error'
      ? darkMode
        ? 'bg-red-950/40 border-red-800 text-red-200'
        : 'bg-red-50 border-red-300 text-red-800'
      : darkMode
        ? 'bg-amber-950/30 border-amber-800 text-amber-200'
        : 'bg-amber-50 border-amber-300 text-amber-800';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${palette}`}>
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
      <div className="flex-1 min-w-0 space-y-1">{children}</div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
        className="shrink-0 -m-1 p-1 rounded-md opacity-70 hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10"
      >
        <X className="w-4 h-4" aria-hidden />
      </button>
    </div>
  );
}
