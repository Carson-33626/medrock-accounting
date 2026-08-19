'use client';

/**
 * QboImportGuide — the checklist modal behind every "QBO Import CSV" button
 * (PostPanel, EndOfMonthTab draft cards, JournalEntryPanel). Barbara's
 * 2026-08-19 import failed with "Line Account invalid" on every line because
 * QuickBooks' import wizard cannot match bare account names while the
 * company's "Enable account numbers" setting is on — a step nobody can guess
 * from the wizard itself, so the download now walks through it.
 *
 * The modal never blocks the download: the primary button downloads and
 * closes; the steps are guidance, not enforced state.
 */
import { Download, X } from 'lucide-react';

interface QboImportGuideProps {
  open: boolean;
  onClose: () => void;
  darkMode: boolean;
  /** QuickBooks company this CSV must be imported into (one CSV = one company). */
  entity: string;
  /** Direct-download variant (anchor). Mutually exclusive with onDownload. */
  href?: string;
  /** Callback variant (PostPanel drives its own fetch/blob download). */
  onDownload?: () => void;
}

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: 'QuickBooks requires account numbers OFF to import — no way around it',
    body: 'QuickBooks’ own import guide says: "Before import, make sure ‘Enable account numbers’ in the Advanced settings is turned off." With the setting on, every line fails as "Line Account invalid" no matter how the file is formatted (bare and numbered names both verified to fail). If turning it off even briefly is not acceptable, use the Post button instead — it writes through the API and needs no settings changes.',
  },
  {
    title: 'Editing the file first? Edit safely',
    body: 'Change amounts or memos if you need to, but leave the AccountName column EXACTLY as exported (numbers, spelling, and ":" sub-account separators untouched), keep dates MM/DD/YYYY, keep each row Debit OR Credit (never both), and keep every JE balanced. Save as CSV — not Excel workbook — and watch that Excel does not reformat dates or account numbers.',
  },
  {
    title: 'Import the file',
    body: 'Gear icon → Import data → Journal entries → upload this CSV. Pick MM/DD/YYYY when the wizard asks for the date format.',
  },
  {
    title: 'Keep JournalNo exactly as exported',
    body: 'Map JournalNo → Journal no. and do not edit its values — it is how this app recognizes the entry was posted manually and stops the draft from double-counting at month-end.',
  },
];

export default function QboImportGuide({ open, onClose, darkMode, entity, href, onDownload }: QboImportGuideProps) {
  if (!open) return null;

  const card = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const sub = darkMode ? 'text-slate-300' : 'text-slate-600';
  const badge = darkMode ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 text-slate-700';
  const primary = 'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700';
  const secondary = `px-4 py-2 text-sm font-medium rounded-lg border ${
    darkMode ? 'border-slate-600 text-slate-100 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
  }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label="QuickBooks import checklist">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative rounded-2xl shadow-2xl max-w-lg w-full mx-4 p-6 ${card}`}>
        <button onClick={onClose} aria-label="Close" className={`absolute top-4 right-4 ${sub} hover:opacity-70`}>
          <X className="w-5 h-5" aria-hidden />
        </button>

        <h2 className="text-lg font-semibold mb-1">Import into QuickBooks — checklist</h2>
        <p className={`text-sm mb-4 ${sub}`}>
          One CSV = one company. This file imports into <span className="font-semibold">{entity}</span> only.
        </p>

        <ol className="space-y-3 mb-6">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${badge}`}>{i + 1}</span>
              <div>
                <div className="text-sm font-medium">{s.title}</div>
                <div className={`text-xs mt-0.5 ${sub}`}>{s.body}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className={secondary}>Cancel</button>
          {href ? (
            <a href={href} download onClick={onClose} className={primary}>
              <Download className="w-4 h-4" aria-hidden />
              Download CSV
            </a>
          ) : (
            <button
              onClick={() => {
                onDownload?.();
                onClose();
              }}
              className={primary}
            >
              <Download className="w-4 h-4" aria-hidden />
              Download CSV
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
