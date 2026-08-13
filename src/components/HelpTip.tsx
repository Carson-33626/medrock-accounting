'use client';

import { useCallback, useRef, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';

const TIP_WIDTH = 288;
const EDGE_PAD = 8;

/**
 * Inline "?" icon that reveals an explanation on hover, keyboard focus, or
 * click/tap (click pins the tip open until dismissed).
 *
 * The tip renders with `position: fixed` so it escapes `overflow-x-auto`
 * table wrappers — an absolutely-positioned tooltip inside those containers
 * gets clipped at the scroll edge.
 */
export default function HelpTip({ text, label }: { text: string; label?: string }) {
  const { darkMode } = useDarkMode();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const pinnedRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const show = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const half = TIP_WIDTH / 2;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, EDGE_PAD + half),
      window.innerWidth - EDGE_PAD - half,
    );
    setPos({ top: rect.top - 6, left });
  }, []);

  const hide = useCallback((force: boolean) => {
    if (force) pinnedRef.current = false;
    if (!pinnedRef.current) setPos(null);
  }, []);

  return (
    <span className="relative inline-flex align-middle">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label ?? 'What is this?'}
        onMouseEnter={show}
        onMouseLeave={() => hide(false)}
        onFocus={show}
        onBlur={() => hide(true)}
        onClick={(e) => {
          // HelpTips sit inside clickable rows and sortable headers — the icon
          // must never trigger those.
          e.stopPropagation();
          if (pos && pinnedRef.current) {
            hide(true);
          } else {
            pinnedRef.current = true;
            show();
          }
        }}
        className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-semibold leading-none transition-colors ${
          darkMode
            ? 'border-slate-500 text-slate-400 hover:border-slate-300 hover:text-slate-200'
            : 'border-slate-400 text-slate-500 hover:border-slate-600 hover:text-slate-700'
        }`}
      >
        ?
      </button>
      {pos && (
        <span
          role="tooltip"
          style={{ top: pos.top, left: pos.left, width: TIP_WIDTH }}
          className={`fixed z-50 -translate-x-1/2 -translate-y-full rounded-lg border p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal shadow-lg ${
            darkMode
              ? 'border-slate-600 bg-slate-800 text-slate-200'
              : 'border-slate-300 bg-white text-slate-700'
          }`}
        >
          {text}
        </span>
      )}
    </span>
  );
}
