'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type {
  QbCandidatesResponse,
  QbLinkRow,
  QbLinksResponse,
  QbLinkStatusOrUnsynced,
  QbSyncResult,
} from '@/types/qb-links';

const PAGE_SIZE = 50;

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** One selector drives both APIs: receipts use the long RDS name, sync uses the QB key. */
const LOCATIONS = [
  { rds: 'MedRock Florida', qb: 'MedRock FL', label: 'Florida' },
  { rds: 'MedRock Tennessee', qb: 'MedRock TN', label: 'Tennessee' },
  { rds: 'MedRock Texas', qb: 'MedRock TX', label: 'Texas' },
] as const;

const STATUS_META: Record<QbLinkStatusOrUnsynced, { label: string; color: string; hint: string }> = {
  auto: { label: 'Auto-matched', color: '#16a34a', hint: 'Matched by vendor+amount or unique amount' },
  manual: { label: 'Manually linked', color: '#2563eb', hint: 'Linked by a reviewer' },
  review: { label: 'Needs review', color: '#d97706', hint: 'Multiple QB candidates share the amount' },
  unmatched: { label: 'Unmatched', color: '#dc2626', hint: 'No QB document found near the amount/date' },
  rejected: { label: 'No QB doc', color: '#64748b', hint: 'Reviewed — confirmed no QB document exists' },
  unsynced: { label: 'Not synced', color: '#94a3b8', hint: 'Run a sync for this location' },
};

const STATUS_ORDER: QbLinkStatusOrUnsynced[] = ['auto', 'manual', 'review', 'unmatched', 'rejected', 'unsynced'];

function qbDeepLink(docType: string, docId: string): string {
  return docType === 'Bill'
    ? `https://app.qbo.intuit.com/app/bill?txnId=${docId}`
    : `https://app.qbo.intuit.com/app/expense?txnId=${docId}`;
}

export default function QbLinksReview() {
  const { darkMode } = useDarkMode();

  const [location, setLocation] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);

  const [data, setData] = useState<QbLinksResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [syncing, setSyncing] = useState(false);
  const [syncReport, setSyncReport] = useState<string | null>(null);

  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<QbCandidatesResponse | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 350);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({
      location,
      status,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (debouncedSearch) params.set('search', debouncedSearch);
    fetch(`/api/inventory/qb-links?${params.toString()}`)
      .then((r) => r.json() as Promise<QbLinksResponse | { error: string }>)
      .then((d) => {
        if (cancelled) return;
        if ('error' in d) setError(d.error);
        else {
          setData(d);
          setError(null);
        }
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
  }, [location, status, debouncedSearch, page, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncReport(null);
    try {
      const qbLoc = LOCATIONS.find((l) => l.rds === location)?.qb ?? 'all';
      const res = await fetch(`/api/inventory/qb-links/sync?location=${encodeURIComponent(qbLoc)}`, {
        method: 'POST',
      });
      const body = (await res.json()) as { results: QbSyncResult[]; errors: Record<string, string> };
      const parts: string[] = body.results.map(
        (r) =>
          `${r.location}: ${r.receipts} receipts -> ${r.counts.auto} auto (${usd0.format(r.values.auto)}), ` +
          `${r.counts.review} review, ${r.counts.unmatched} unmatched` +
          (r.preservedDecisions > 0 ? `, ${r.preservedDecisions} manual decisions kept` : ''),
      );
      for (const [loc, msg] of Object.entries(body.errors)) {
        parts.push(`${loc}: FAILED — ${msg.includes('invalid_grant') || msg.includes('not connected') ? 'QB connection needs re-authorization in Admin' : msg}`);
      }
      setSyncReport(parts.join(' • '));
      refresh();
    } catch (e: unknown) {
      setSyncReport(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [location, refresh]);

  const openPicker = useCallback(async (receiptId: string) => {
    setPickerFor(receiptId);
    setCandidates(null);
    setCandidatesLoading(true);
    try {
      const res = await fetch(`/api/inventory/qb-links/candidates?receipt_id=${encodeURIComponent(receiptId)}`);
      const body = (await res.json()) as QbCandidatesResponse | { error: string };
      if (!('error' in body)) setCandidates(body);
    } finally {
      setCandidatesLoading(false);
    }
  }, []);

  const decide = useCallback(
    async (receiptId: string, action: 'link' | 'reject' | 'reset', qbDocKey?: string) => {
      await fetch('/api/inventory/qb-links/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt_id: receiptId, action, qb_doc_key: qbDocKey }),
      });
      setPickerFor(null);
      setCandidates(null);
      refresh();
    },
    [refresh],
  );

  const totalsByStatus = useMemo(() => {
    const m = new Map<QbLinkStatusOrUnsynced, { receipts: number; value: number }>();
    for (const t of data?.totals ?? []) m.set(t.status, { receipts: t.receipts, value: t.value });
    return m;
  }, [data]);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const tableHead = darkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600';
  const rowBorder = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;

  const lastSyncLine = useMemo(() => {
    if (!data) return '';
    return LOCATIONS.map((l) => {
      const ts = data.lastSync[l.qb];
      return `${l.label}: ${ts ? new Date(ts).toLocaleString() : 'never'}`;
    }).join(' · ');
  }, [data]);

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-screen-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              QuickBooks Purchase Links
            </h1>
            <p className={`text-sm ${subText}`}>
              Each receiving entry linked to the QB bill or card purchase that paid for it — the paid
              dates power cash-basis valuation.
            </p>
            {lastSyncLine && <p className={`text-xs mt-1 ${subText}`}>Last sync — {lastSyncLine}</p>}
          </div>
          <div className="flex items-center gap-2">
            <a href="/inventory" className={`px-3 py-2 text-sm rounded-lg border ${rowBorder} ${cardBg}`}>
              ← Valuation
            </a>
            <button
              onClick={() => void runSync()}
              disabled={syncing}
              className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-50"
              style={{ backgroundColor: '#5e3b8d' }}
            >
              {syncing ? 'Syncing…' : `Sync ${location === 'all' ? 'all locations' : LOCATIONS.find((l) => l.rds === location)?.label ?? ''}`}
            </button>
          </div>
        </div>

        {syncReport && (
          <div className={`rounded-lg border px-4 py-3 text-sm ${rowBorder} ${cardBg}`}>{syncReport}</div>
        )}
        {error && (
          <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">{error}</div>
        )}

        {/* Status cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {STATUS_ORDER.map((s) => {
            const t = totalsByStatus.get(s);
            const meta = STATUS_META[s];
            const active = status === s;
            return (
              <button
                key={s}
                title={meta.hint}
                onClick={() => {
                  setStatus(active ? 'all' : s);
                  setPage(0);
                }}
                className={`rounded-xl shadow-sm p-4 text-left ${cardBg} ${active ? 'ring-2' : ''}`}
                style={active ? { boxShadow: `0 0 0 2px ${meta.color}` } : undefined}
              >
                <p className={`text-xs uppercase tracking-wide ${subText}`}>{meta.label}</p>
                <p className="text-xl font-bold mt-1" style={{ color: meta.color }}>
                  {t ? usd0.format(t.value) : '—'}
                </p>
                <p className={`text-xs mt-0.5 ${subText}`}>{t ? `${t.receipts.toLocaleString()} receipts` : 'none'}</p>
              </button>
            );
          })}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={location}
            onChange={(e) => {
              setLocation(e.target.value);
              setPage(0);
            }}
            className={inputCls}
          >
            <option value="all">All locations</option>
            {LOCATIONS.map((l) => (
              <option key={l.rds} value={l.rds}>
                {l.label}
              </option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search product or vendor…"
            className={`${inputCls} w-64`}
          />
          {loading && <span className={`text-sm ${subText}`}>Loading…</span>}
        </div>

        {/* Table */}
        <div className={`rounded-xl shadow-sm overflow-x-auto ${cardBg}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className={tableHead}>
                <th className="text-left px-4 py-3 font-medium">Received</th>
                <th className="text-left px-4 py-3 font-medium">Product</th>
                <th className="text-left px-4 py-3 font-medium">Receipt Vendor</th>
                <th className="text-right px-4 py-3 font-medium">Amount</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">QB Document</th>
                <th className="text-left px-4 py-3 font-medium">Paid</th>
                <th className="text-left px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((r: QbLinkRow) => {
                const meta = STATUS_META[r.status];
                return (
                  <FragmentRow
                    key={r.receipt_id}
                    row={r}
                    metaColor={meta.color}
                    metaLabel={meta.label}
                    rowBorder={rowBorder}
                    subText={subText}
                    pickerOpen={pickerFor === r.receipt_id}
                    candidates={pickerFor === r.receipt_id ? candidates : null}
                    candidatesLoading={pickerFor === r.receipt_id && candidatesLoading}
                    onPick={() => void openPicker(r.receipt_id)}
                    onClosePicker={() => {
                      setPickerFor(null);
                      setCandidates(null);
                    }}
                    onDecide={(action, key) => void decide(r.receipt_id, action, key)}
                    darkMode={darkMode}
                  />
                );
              })}
              {data && data.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className={`px-4 py-8 text-center ${subText}`}>
                    No receipts match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.total > PAGE_SIZE && (
          <div className="flex items-center justify-between">
            <p className={`text-sm ${subText}`}>
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.total)} of {data.total.toLocaleString()} receipts
            </p>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className={`px-3 py-1.5 rounded-lg border ${rowBorder} disabled:opacity-40 ${cardBg}`}
              >
                Previous
              </button>
              <button
                disabled={(page + 1) * PAGE_SIZE >= data.total}
                onClick={() => setPage((p) => p + 1)}
                className={`px-3 py-1.5 rounded-lg border ${rowBorder} disabled:opacity-40 ${cardBg}`}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface FragmentRowProps {
  row: QbLinkRow;
  metaColor: string;
  metaLabel: string;
  rowBorder: string;
  subText: string;
  pickerOpen: boolean;
  candidates: QbCandidatesResponse | null;
  candidatesLoading: boolean;
  onPick: () => void;
  onClosePicker: () => void;
  onDecide: (action: 'link' | 'reject' | 'reset', qbDocKey?: string) => void;
  darkMode: boolean;
}

function FragmentRow({
  row: r,
  metaColor,
  metaLabel,
  rowBorder,
  subText,
  pickerOpen,
  candidates,
  candidatesLoading,
  onPick,
  onClosePicker,
  onDecide,
  darkMode,
}: FragmentRowProps) {
  const locShort = r.location.replace('MedRock ', '');
  return (
    <>
      <tr className={`border-t ${rowBorder}`}>
        <td className="px-4 py-2.5 whitespace-nowrap">
          {r.date_received}
          <span className={`ml-1.5 text-xs ${subText}`}>{locShort}</span>
        </td>
        <td className="px-4 py-2.5 max-w-xs truncate" title={r.product_name ?? undefined}>
          {r.product_name ?? '—'}
        </td>
        <td className="px-4 py-2.5 max-w-[10rem] truncate" title={r.vendor ?? undefined}>
          {r.vendor || <span className={subText}>blank</span>}
        </td>
        <td className="px-4 py-2.5 text-right whitespace-nowrap">{usd.format(r.total_cost)}</td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          <span
            className="inline-block px-2 py-0.5 rounded-full text-xs font-medium text-white"
            style={{ backgroundColor: metaColor }}
            title={r.confidence !== null ? `confidence ${r.confidence}` : undefined}
          >
            {metaLabel}
          </span>
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          {r.qb_doc_key && r.doc_type && r.doc_id ? (
            <a
              href={qbDeepLink(r.doc_type, r.doc_id)}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted"
              title={`${r.qb_vendor ?? ''} — ${r.qb_txn_date ?? ''} — ${r.qb_total !== null ? usd.format(r.qb_total) : ''}`}
            >
              {r.doc_type} · {(r.qb_vendor ?? '').slice(0, 22) || r.doc_id}
            </a>
          ) : (
            <span className={subText}>—</span>
          )}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          {r.qb_paid_date ?? (r.qb_doc_key ? <span className={subText}>unpaid</span> : <span className={subText}>—</span>)}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap space-x-2">
          <button onClick={pickerOpen ? onClosePicker : onPick} className="text-xs underline decoration-dotted">
            {pickerOpen ? 'close' : 'pick'}
          </button>
          {r.status !== 'rejected' && (
            <button onClick={() => onDecide('reject')} className={`text-xs underline decoration-dotted ${subText}`}>
              no QB doc
            </button>
          )}
          {(r.status === 'manual' || r.status === 'rejected') && (
            <button onClick={() => onDecide('reset')} className={`text-xs underline decoration-dotted ${subText}`}>
              reset
            </button>
          )}
        </td>
      </tr>
      {pickerOpen && (
        <tr className={`border-t ${rowBorder}`}>
          <td colSpan={8} className={`px-6 py-3 ${darkMode ? 'bg-slate-900/50' : 'bg-slate-50'}`}>
            {candidatesLoading && <p className={`text-sm ${subText}`}>Loading candidates…</p>}
            {!candidatesLoading && candidates && candidates.candidates.length === 0 && (
              <p className={`text-sm ${subText}`}>
                No nearby QB documents share this vendor or amount. Try a sync, or mark “no QB doc”.
              </p>
            )}
            {!candidatesLoading && candidates && candidates.candidates.length > 0 && (
              <div className="space-y-1.5">
                {candidates.candidates.map((c) => (
                  <div key={c.qb_doc_key} className="flex items-center gap-3 text-sm">
                    <button
                      onClick={() => onDecide('link', c.qb_doc_key)}
                      className="px-2 py-0.5 rounded text-xs font-medium text-white"
                      style={{ backgroundColor: '#2563eb' }}
                    >
                      link
                    </button>
                    <span className="whitespace-nowrap">{c.txn_date}</span>
                    <span className="max-w-[14rem] truncate" title={c.vendor ?? undefined}>
                      {c.vendor ?? '—'}
                    </span>
                    <span className="whitespace-nowrap font-medium">{usd.format(c.total_amount)}</span>
                    <span className={`text-xs ${subText}`}>
                      {c.doc_type} · {c.days_apart}d apart
                      {c.amount_exact ? ' · exact amount' : ''}
                      {c.vendor_match ? ' · vendor match' : ''}
                      {c.paid_date ? ` · paid ${c.paid_date}` : ' · unpaid'}
                    </span>
                    <a
                      href={qbDeepLink(c.doc_type, c.doc_id)}
                      target="_blank"
                      rel="noreferrer"
                      className={`text-xs underline decoration-dotted ${subText}`}
                    >
                      open in QBO
                    </a>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
