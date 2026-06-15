'use client';

import { useDarkMode } from '@/contexts/DarkModeContext';
import type { TaxFiling } from '@/lib/sales-tax-filings';

/** Page chrome shared by every per-filing sales-tax page. */
export default function SalesTaxShell({
  filing,
  description,
  children,
}: {
  filing: TaxFiling;
  /** Per-filing explainer shown under the title. */
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { darkMode } = useDarkMode();
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const eyebrow = darkMode ? 'text-slate-500' : 'text-slate-400';
  const dueBg = darkMode
    ? 'bg-amber-950/40 border-amber-800/60 text-amber-200'
    : 'bg-amber-50 border-amber-200 text-amber-900';

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${eyebrow}`}>
            Sales Tax · {filing.entity}
          </p>
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            {filing.stateName} — {filing.form}
          </h1>

          {/* When it must be filed by — required on every filing header */}
          <div className={`mt-2 inline-flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${dueBg}`}>
            <CalendarIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>
              <strong>{filing.cadence}</strong> · {filing.due}
            </span>
          </div>

          {description ? (
            <div className={`text-sm mt-3 ${subText}`}>{description}</div>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export function StatePlaceholder({ title, note }: { title: string; note: string }) {
  const { darkMode } = useDarkMode();
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  return (
    <div className={`rounded-xl shadow-sm p-6 ${cardBg}`}>
      <p className="text-sm font-semibold mb-2">{title}</p>
      <p className={`text-sm ${subText}`}>{note}</p>
    </div>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}
