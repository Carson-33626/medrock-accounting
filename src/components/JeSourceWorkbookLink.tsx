'use client';

import { Download } from 'lucide-react';

/**
 * The download half of "every journal entry ships two things" — the entry AND the source data
 * that led to it, in one workbook.
 *
 * Carson, 2026-09-04: *"Every single journal entry posting button needs to include 2 files: the
 * entry itself, as well as the source data that led us to that ruling. Especially if we get
 * audited, we will not have the time to generate everything."*
 *
 * The QuickBooks attachment side of that already fires on every post (`je-attach`). This is the
 * other side: `/api/payroll/export?headerId=…` returns the SAME assembled workbook
 * (`buildJeSourceWorkbook`) the attachment uploads, so an accountant can read it before posting
 * and re-pull it afterwards without opening QuickBooks. Until now that button existed only on
 * the payroll Post panel; the inventory close, the opening correction, the lab accrual and the
 * month-end allocation all offered nothing but the QBO import CSV.
 *
 * DELIBERATELY NOT GATED ON `posted`. The QBO import CSV is hidden once an entry is live —
 * re-importing it would duplicate the entry — but the source workbook is a read of the stored
 * draft and its evidence, which is exactly what an auditor asks for after the fact.
 */
export default function JeSourceWorkbookLink({
  headerId,
  docNumber,
  darkMode,
  scope,
  compact,
}: {
  headerId: number;
  /** For the tooltip only, so the accountant can see which entry they are pulling. */
  docNumber: string;
  darkMode: boolean;
  /** 'run' exports every split piece of a payroll run; omit for the single-header kinds. */
  scope?: 'run';
  /** Row-sized, for a table of entries rather than a card's action bar. */
  compact?: boolean;
}) {
  const title =
    `Download ${docNumber} as an .xlsx: the journal entry itself plus the source detail it was ` +
    'computed from. The same workbook is attached to the entry in QuickBooks when it posts.';
  const href = `/api/payroll/export?headerId=${headerId}${scope ? `&scope=${scope}` : ''}`;
  const border = darkMode
    ? 'border-slate-600 text-slate-200 hover:bg-slate-700'
    : 'border-slate-300 text-slate-700 hover:bg-slate-100';

  if (compact) {
    return (
      <a
        href={href}
        download
        title={title}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${border}`}
      >
        <Download className="w-3 h-3" aria-hidden />
        Entry + source
      </a>
    );
  }

  return (
    <a
      href={href}
      download
      title={title}
      className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border ${border}`}
    >
      <Download className="w-4 h-4" aria-hidden />
      Entry + source (.xlsx)
    </a>
  );
}
