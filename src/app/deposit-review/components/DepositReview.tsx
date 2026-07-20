'use client';

import { useEffect, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type { DepositReviewSummary, DepositRecord } from '@/lib/deposits/summary';

const DRIVE_FOLDER_URL = 'https://drive.google.com/drive/folders/1VsPky7ENithxBcdXAu5yi5DNfZ7JaBZH';

function relativeTime(isoDate: string, now: Date): string {
  const then = new Date(`${isoDate}T00:00:00Z`);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const days = Math.round((today.getTime() - then.getTime()) / (24 * 60 * 60 * 1000));

  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days > 1) return `${days} days ago`;
  if (days === -1) return 'in 1 day';
  return `in ${-days} days`;
}

function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${m}/${d}/${y}`;
}

export function DepositReview() {
  const { darkMode } = useDarkMode();
  const [data, setData] = useState<DepositReviewSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch('/api/deposit-review/summary')
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<DepositReviewSummary>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  };

  useEffect(() => {
    const cancel = load();
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const headingText = darkMode ? 'text-white' : 'text-slate-900';
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const headBg = darkMode ? 'bg-slate-900/60' : 'bg-slate-50';
  const rowBorder = darkMode ? 'divide-slate-700' : 'divide-slate-100';

  const header = (
    <div>
      <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Deposits</p>
      <h1 className={`text-2xl font-bold ${headingText}`}>Deposit Slip Review</h1>
      <p className={`text-sm mt-2 ${subText}`}>
        Visibility into what has been uploaded to the Deposit Slips Drive folder — counts, recent activity, and
        a direct link into Drive itself. Read-only; browsing, previewing, and downloading happen in Drive.
      </p>
    </div>
  );

  if (loading) {
    return (
      <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
        <div className="max-w-6xl mx-auto space-y-6">
          {header}
          <div className={`rounded-xl shadow-sm p-8 ${cardBg} flex items-center justify-center`}>
            <div className="animate-spin w-6 h-6 border-2 border-current border-t-transparent rounded-full opacity-50" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
        <div className="max-w-6xl mx-auto space-y-6">
          {header}
          <div className={`rounded-xl shadow-sm p-6 ${cardBg}`}>
            <p className="text-sm font-semibold text-red-500">Could not reach Google Drive</p>
            <p className={`text-sm mt-1 ${subText}`}>{error ?? 'No data'}</p>
            <button
              onClick={load}
              className="mt-4 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
              style={{ backgroundColor: '#5e3b8d' }}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const now = new Date();

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-6xl mx-auto space-y-6">
        {header}
        <DepositReviewContent
          data={data}
          now={now}
          cardBg={cardBg}
          subText={subText}
          border={border}
          headBg={headBg}
          rowBorder={rowBorder}
        />
      </div>
    </div>
  );
}

function DepositReviewContent({
  data,
  now,
  cardBg,
  subText,
  border,
  headBg,
  rowBorder,
}: {
  data: DepositReviewSummary;
  now: Date;
  cardBg: string;
  subText: string;
  border: string;
  headBg: string;
  rowBorder: string;
}) {
  return (
    <div className="space-y-6">
      {/* Drive link */}
      <a
        href={DRIVE_FOLDER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`flex items-center justify-between rounded-xl shadow-sm p-5 ${cardBg} border ${border} hover:opacity-90 transition-opacity`}
      >
        <div>
          <p className="font-semibold">Open Deposit Slips in Google Drive</p>
          <p className={`text-sm mt-0.5 ${subText}`}>
            Browse, preview, search, and share files directly — this page is read-only.
          </p>
        </div>
        <span
          className="flex-shrink-0 ml-4 px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ backgroundColor: '#5e3b8d' }}
        >
          Open Drive →
        </span>
      </a>

      {/* Summary tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className={`rounded-xl shadow-sm p-5 ${cardBg} border ${border}`}>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Total files</p>
          <p className="text-3xl font-bold mt-1">{data.totalFiles}</p>
        </div>
        <div className={`rounded-xl shadow-sm p-5 ${cardBg} border ${border}`}>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Uploaded this month</p>
          <p className="text-3xl font-bold mt-1">{data.thisMonthCount}</p>
        </div>
        <div className={`rounded-xl shadow-sm p-5 ${cardBg} border ${border}`}>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Most recent upload</p>
          {data.mostRecent ? (
            <div className="mt-1">
              <p className="font-semibold truncate" title={data.mostRecent.fileName}>
                {data.mostRecent.fileName}
              </p>
              <p className={`text-sm mt-0.5 ${subText}`}>
                {data.mostRecent.isoDate ? (
                  <>
                    {formatDate(data.mostRecent.isoDate)} · {relativeTime(data.mostRecent.isoDate, now)}
                  </>
                ) : (
                  'Date unknown'
                )}
                {data.mostRecent.uploader ? ` · ${data.mostRecent.uploader}` : ''}
              </p>
            </div>
          ) : (
            <p className={`text-sm mt-1 ${subText}`}>No uploads yet</p>
          )}
        </div>
      </div>

      {/* Per-location cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {data.locations.map((loc) => (
          <div key={loc.location} className={`rounded-xl shadow-sm p-5 ${cardBg} border ${border}`}>
            <p className="font-semibold">{loc.location}</p>
            <div className="mt-2 space-y-1">
              <p className="text-sm">
                <span className="font-medium">{loc.fileCount}</span>{' '}
                <span className={subText}>total ·</span> <span className="font-medium">{loc.thisMonthCount}</span>{' '}
                <span className={subText}>this month</span>
              </p>
              <p className={`text-sm ${subText}`}>
                {loc.latestUploadDate ? `Latest: ${formatDate(loc.latestUploadDate)}` : 'No uploads yet'}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Recent uploads table */}
      <div className={`rounded-xl shadow-sm overflow-hidden ${cardBg} border ${border}`}>
        <div className={`px-5 py-4 border-b ${border}`}>
          <p className="font-semibold">Recent uploads</p>
          <p className={`text-sm mt-0.5 ${subText}`}>
            {data.recent.length} most recent, newest first. No monthly total is shown — the amount field is
            optional on upload, so any total would be silently incomplete.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className={headBg}>
              <tr className={`text-left ${subText}`}>
                <th className="px-5 py-2 font-semibold">Date</th>
                <th className="px-5 py-2 font-semibold">Location</th>
                <th className="px-5 py-2 font-semibold">Type</th>
                <th className="px-5 py-2 font-semibold text-right">Amount</th>
                <th className="px-5 py-2 font-semibold">Uploader</th>
                <th className="px-5 py-2 font-semibold">File</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${rowBorder}`}>
              {data.recent.length === 0 ? (
                <tr>
                  <td colSpan={6} className={`px-5 py-6 text-center ${subText}`}>
                    No uploads yet.
                  </td>
                </tr>
              ) : (
                data.recent.map((r) => <RecentRow key={r.fileId} record={r} subText={subText} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function RecentRow({ record, subText }: { record: DepositRecord; subText: string }) {
  return (
    <tr>
      <td className="px-5 py-2.5 whitespace-nowrap">
        {record.isoDate ? formatDate(record.isoDate) : <span className={subText}>—</span>}
      </td>
      <td className="px-5 py-2.5 whitespace-nowrap">{record.location}</td>
      <td className="px-5 py-2.5 whitespace-nowrap">
        {record.type ?? <span className={subText}>—</span>}
      </td>
      <td className="px-5 py-2.5 whitespace-nowrap text-right">
        {record.amount ?? <span className={subText}>—</span>}
      </td>
      <td className="px-5 py-2.5 whitespace-nowrap">
        {record.uploader ?? <span className={subText}>—</span>}
      </td>
      <td className="px-5 py-2.5 whitespace-nowrap">
        <a
          href={record.webViewLink}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium hover:underline"
          style={{ color: '#5e3b8d' }}
        >
          {record.fileName}
        </a>
      </td>
    </tr>
  );
}
