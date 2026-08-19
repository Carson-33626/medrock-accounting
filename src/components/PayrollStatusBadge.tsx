'use client';

/**
 * PayrollStatusBadge — the one status pill for payroll/EOM/inventory-close headers,
 * colored so a list scans at a glance (Carson, 2026-08-19: "so I can easily see
 * which payrolls are done"). Replaces three identical neutral-slate copies in
 * PayrollsLanding / PostPanel / EndOfMonthTab.
 *
 * Color semantics: posted = green (done), approved = blue (cleared to post),
 * needs review = amber (waiting on a person), error = red, draft = neutral slate.
 * Unknown statuses render neutral with the raw value rather than guessing.
 */

export type PayrollBadgeStatus = 'draft' | 'needs_review' | 'approved' | 'posted' | 'error';

const LABEL: Record<PayrollBadgeStatus, string> = {
  draft: 'Draft',
  needs_review: 'Needs review',
  approved: 'Approved',
  posted: 'Posted',
  error: 'Error',
};

const COLOR: Record<PayrollBadgeStatus, { dark: string; light: string }> = {
  posted: { dark: 'bg-emerald-950/60 text-emerald-200 border-emerald-800', light: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  approved: { dark: 'bg-blue-950/60 text-blue-200 border-blue-800', light: 'bg-blue-50 text-blue-700 border-blue-200' },
  needs_review: { dark: 'bg-amber-950/60 text-amber-200 border-amber-800', light: 'bg-amber-50 text-amber-700 border-amber-200' },
  error: { dark: 'bg-red-950/60 text-red-200 border-red-800', light: 'bg-red-50 text-red-700 border-red-200' },
  draft: { dark: 'bg-slate-700 text-slate-200 border-slate-600', light: 'bg-slate-100 text-slate-600 border-slate-200' },
};

const NEUTRAL = COLOR.draft;

function isKnown(status: string): status is PayrollBadgeStatus {
  return status in LABEL;
}

export default function PayrollStatusBadge({ darkMode, status }: { darkMode: boolean; status: string }) {
  const known = isKnown(status);
  const color = known ? COLOR[status] : NEUTRAL;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
        darkMode ? color.dark : color.light
      }`}
    >
      {known ? LABEL[status] : status}
    </span>
  );
}
