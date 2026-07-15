'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';

/**
 * Collapsible "how this page works" banner shown at the top of each payroll view.
 * Expanded by default so first-time users see the directions; collapsible so daily
 * users can tuck it away. Purely presentational — no data, no side effects.
 */
export function DirectionsBanner({
  darkMode,
  title,
  children,
  defaultOpen = true,
}: {
  darkMode: boolean;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const wrap = darkMode
    ? 'bg-blue-950/40 border-blue-900 text-blue-100'
    : 'bg-blue-50 border-blue-200 text-blue-900';

  return (
    <div className={`rounded-xl border p-3 ${wrap}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-sm font-semibold"
      >
        <Info className="w-4 h-4 shrink-0" aria-hidden />
        <span className="flex-1">{title}</span>
        {open ? <ChevronDown className="w-4 h-4" aria-hidden /> : <ChevronRight className="w-4 h-4" aria-hidden />}
      </button>
      {open && <div className="mt-2 space-y-1 text-sm leading-relaxed opacity-90">{children}</div>}
    </div>
  );
}
