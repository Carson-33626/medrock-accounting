'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, XCircle } from 'lucide-react';

type EomEntity = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';
interface DiffStatus {
  lastRun: { finishedAt: string | null; ok: boolean | null; error: string | null } | null;
  flagged: Array<{ month: string; entities: Array<{ entity: EomEntity; deltaDebits: number }> }>;
}
const SHORT: Record<EomEntity, string> = { 'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX' };
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const monthLabel = (m: string): string =>
  new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
const timeLabel = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

/**
 * Month-end allocation difference banner (DS 2026-09-25 §4.4) — on every Journal Entries page.
 * Hidden when nothing is flagged or the status can't be read: it never breaks a page.
 */
export function EomDiffBanner({ darkMode }: { darkMode: boolean }) {
  const [status, setStatus] = useState<DiffStatus | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/payroll/eom/diff')
      .then(async (res) => (res.ok ? ((await res.json()) as DiffStatus) : null))
      .then((s) => { if (live) setStatus(s); })
      .catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, []);
  if (!status) return null;

  const failed = status.lastRun !== null && status.lastRun.ok === false;
  if (!failed && status.flagged.length === 0) return null;

  const amber = darkMode ? 'border-amber-700 bg-amber-950/40 text-amber-100' : 'border-amber-300 bg-amber-50 text-amber-900';
  const red = darkMode ? 'border-red-800 bg-red-950/40 text-red-100' : 'border-red-300 bg-red-50 text-red-900';
  return (
    <div className="space-y-2" role="status">
      {failed && (
        <div className={`rounded-xl border-2 p-3 flex gap-2 items-start text-sm ${red}`}>
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>Couldn&apos;t run the month-end difference check ({timeLabel(status.lastRun?.finishedAt ?? null)}): {status.lastRun?.error ?? 'unknown error'}</p>
        </div>
      )}
      {status.flagged.map((f) => (
        <div key={f.month} className={`rounded-xl border-2 p-3 flex flex-wrap gap-2 items-center text-sm ${amber}`}>
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
          <span className="font-semibold">Month-end allocation difference — {monthLabel(f.month)}:</span>
          <span>{f.entities.map((e) => `${SHORT[e.entity]} ${usd.format(e.deltaDebits)}`).join(' · ')}</span>
          <span className="opacity-75">(checked {timeLabel(status.lastRun?.finishedAt ?? null)})</span>
          <Link href={`/journal-entries/end-of-month?month=${f.month}`} className="ml-auto font-semibold underline">
            Review &amp; post correction →
          </Link>
        </div>
      ))}
    </div>
  );
}
