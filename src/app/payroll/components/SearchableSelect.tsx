'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';

export interface SearchableOption {
  /** The value stored on select (e.g. the account/department/class NAME). */
  value: string;
  /** Text shown for the option (usually === value). */
  label: string;
  /** Optional prefix shown + searchable, e.g. a QB account number. */
  hint?: string | null;
}

/**
 * Type-to-filter dropdown for the long QB-backed lists (accounts, departments, classes) that
 * a native <select> makes painful to scan. Search matches both the label and the hint, so an
 * accountant can type an account NAME or its QB account NUMBER. The stored value is always
 * `option.value` (the name) — the hint is display/search only. Keyboard: ↑/↓ move, Enter picks,
 * Esc closes; click-outside closes. Styling mirrors the surrounding inputs via `inputBg`.
 */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  darkMode,
  inputBg,
  className = '',
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchableOption[];
  placeholder?: string;
  disabled?: boolean;
  darkMode: boolean;
  inputBg: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const choose = (o: SearchableOption): void => {
    onChange(o.value);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        setOpen(true);
        setHighlight(0);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = filtered[highlight];
      if (o) choose(o);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  };

  const borderC = darkMode ? 'border-slate-600' : 'border-slate-300';
  const panelBg = darkMode ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200';
  const hoverC = darkMode ? 'bg-slate-700' : 'bg-slate-100';
  const muted = darkMode ? 'text-slate-400' : 'text-slate-500';

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        className={`w-full flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs text-left ${inputBg} disabled:opacity-70 disabled:cursor-not-allowed`}
      >
        <span className={`truncate ${selected ? '' : muted}`}>
          {selected ? (selected.hint ? `${selected.hint} · ${selected.label}` : selected.label) : placeholder}
        </span>
        <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 opacity-60" aria-hidden />
      </button>

      {open && (
        <div className={`absolute z-20 mt-1 w-full min-w-[18rem] rounded-md border shadow-lg ${panelBg}`}>
          <div className={`flex items-center gap-1.5 px-2 py-1.5 border-b ${borderC}`}>
            <Search className="w-3.5 h-3.5 opacity-60 shrink-0" aria-hidden />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search…"
              className="w-full bg-transparent outline-none text-xs"
            />
          </div>
          <ul role="listbox" className="max-h-56 overflow-auto py-1">
            {filtered.length === 0 ? (
              <li className={`px-2 py-1.5 text-xs ${muted}`}>No matches.</li>
            ) : (
              filtered.map((o, i) => {
                const isSel = o.value === value;
                const isHi = i === highlight;
                return (
                  <li
                    key={o.value}
                    role="option"
                    aria-selected={isSel}
                    onMouseEnter={() => setHighlight(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(o);
                    }}
                    className={`flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer ${isHi ? hoverC : ''}`}
                  >
                    <Check className={`w-3.5 h-3.5 shrink-0 ${isSel ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
                    {o.hint && <span className="font-mono tabular-nums opacity-70 shrink-0">{o.hint}</span>}
                    <span className="truncate">{o.label}</span>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
