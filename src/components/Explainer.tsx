'use client';

import { useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';

/**
 * Collapsible "What am I looking at?" panel.
 *
 * Opens itself the FIRST time a browser ever renders the panel (keyed by `id`
 * in localStorage) and stays collapsed on every visit after that. Server
 * render and the initial client render are always collapsed, so the first-run
 * expansion happens post-hydration — that avoids an SSR/client mismatch.
 */
export default function Explainer({
  id,
  title = 'What am I looking at?',
  children,
}: {
  id: string;
  title?: string;
  children: ReactNode;
}) {
  const { darkMode } = useDarkMode();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const key = `explainer-seen:${id}`;
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, new Date().toISOString());
        setOpen(true);
      }
    } catch {
      // localStorage unavailable (private browsing) — stay collapsed.
    }
  }, [id]);

  return (
    <details
      open={open}
      onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)}
      className={`group rounded-xl border shadow-sm ${
        darkMode ? 'border-slate-700 bg-slate-800 text-slate-100' : 'border-slate-200 bg-white text-slate-900'
      }`}
    >
      <summary
        className={`flex cursor-pointer select-none items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden ${
          darkMode ? 'hover:bg-slate-700/40' : 'hover:bg-slate-50'
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white`}
          style={{ backgroundColor: '#5e3b8d' }}
        >
          ?
        </span>
        {title}
        <span
          aria-hidden="true"
          className={`ml-auto text-xs transition-transform group-open:rotate-90 ${
            darkMode ? 'text-slate-400' : 'text-slate-500'
          }`}
        >
          ▶
        </span>
      </summary>
      <div
        className={`space-y-2 px-5 pb-4 pt-1 text-sm leading-relaxed ${
          darkMode ? 'text-slate-300' : 'text-slate-600'
        }`}
      >
        {children}
      </div>
    </details>
  );
}
