'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type { NexusResponse, NexusStateRow, NexusStatus } from '@/lib/nexus';
import { THRESHOLD_BY_ABBR, NEXUS_SOURCES } from '@/lib/nexus-thresholds';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const int = new Intl.NumberFormat('en-US');

const STATUS_RANK: Record<NexusStatus, number> = { over: 0, approaching: 1, registered: 2, under: 3, no_tax: 4 };

const STATUS_LABEL: Record<NexusStatus, string> = {
  over: 'Over threshold',
  approaching: 'Approaching',
  registered: 'Registered',
  under: 'Under',
  no_tax: 'No sales tax',
};

function statusClasses(status: NexusStatus, dark: boolean): string {
  switch (status) {
    case 'over':
      return dark ? 'bg-red-950/60 text-red-300 border-red-800/60' : 'bg-red-50 text-red-700 border-red-200';
    case 'approaching':
      return dark ? 'bg-amber-950/50 text-amber-300 border-amber-800/60' : 'bg-amber-50 text-amber-800 border-amber-200';
    case 'registered':
      return dark ? 'bg-emerald-950/50 text-emerald-300 border-emerald-800/60' : 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'no_tax':
      return dark ? 'bg-slate-800 text-slate-500 border-slate-700' : 'bg-slate-100 text-slate-400 border-slate-200';
    default:
      return dark ? 'bg-slate-800 text-slate-400 border-slate-700' : 'bg-slate-50 text-slate-500 border-slate-200';
  }
}

export default function NexusExposure() {
  const { darkMode } = useDarkMode();
  const [data, setData] = useState<NexusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/sales-tax/nexus')
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        return res.json() as Promise<NexusResponse>;
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
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const sorted = [...data.rows].sort(
      (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.grossYtd - a.grossYtd,
    );
    if (showAll) return sorted;
    return sorted.filter((r) => r.grossYtd > 0 || r.status === 'over' || r.status === 'approaching' || r.registered);
  }, [data, showAll]);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const headBg = darkMode ? 'bg-slate-900/60' : 'bg-slate-50';

  if (loading) {
    return (
      <div className={`rounded-xl shadow-sm p-8 ${cardBg} flex items-center justify-center`}>
        <div className="animate-spin w-6 h-6 border-2 border-current border-t-transparent rounded-full opacity-50" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className={`rounded-xl shadow-sm p-6 ${cardBg}`}>
        <p className="text-sm font-semibold text-red-500">Couldn&apos;t load nexus exposure</p>
        <p className={`text-sm mt-1 ${subText}`}>{error ?? 'No data'}</p>
      </div>
    );
  }

  const pct = Math.round(data.yearFraction * 100);

  return (
    <div className="space-y-5">
      {/* Caveat / framing banner */}
      <div
        className={`rounded-xl border p-4 text-sm ${
          darkMode ? 'bg-sky-950/40 border-sky-800/60 text-sky-200' : 'bg-sky-50 border-sky-200 text-sky-900'
        }`}
      >
        <p className="font-semibold mb-1">How to read this</p>
        <ul className="list-disc ml-5 space-y-0.5">
          <li>
            Figures are <strong>YTD {data.periodStart ?? '?'} → {data.periodEnd ?? '?'}</strong> (~{pct}% of the year).
            The feed starts Jan 2026, so this is <strong>not</strong> a full trailing-12-months — the{' '}
            <em>Projected FY</em> column annualizes YTD to estimate where the year lands.
          </li>
          <li>
            Compared on <strong>gross sales</strong> (all sales incl. exempt Rx — how most states measure). FL &amp; MO
            measure <strong>taxable</strong> sales only, so their real figure is far lower (Rx exempt) — flagged in the
            table.
          </li>
          <li>
            A <strong>screen to feed the CPA nexus study</strong>, not a filing determination. Crossing a threshold
            creates a registration/filing duty even when little or no tax is due (Rx is exempt almost everywhere).
          </li>
          <li>
            Thresholds are <strong>interim references</strong> (sourced below, per-state links in the table) pending the
            CPA&apos;s own nexus determination.
          </li>
        </ul>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard cardBg={cardBg} subText={subText} label="Over — not registered" value={data.summary.overUnregistered} accent="text-red-500" />
        <SummaryCard cardBg={cardBg} subText={subText} label="Approaching" value={data.summary.approaching} accent="text-amber-500" />
        <SummaryCard cardBg={cardBg} subText={subText} label="Registered" value={data.summary.registered} accent="text-emerald-500" />
        <SummaryCard cardBg={cardBg} subText={subText} label="States with sales" value={data.summary.statesWithSales} accent={darkMode ? 'text-slate-200' : 'text-slate-700'} />
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <label className={`flex items-center gap-2 text-sm ${subText}`}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="rounded" />
          Show all 50 states + DC
        </label>
        <div className="flex items-center gap-2">
          <a
            href="/api/sales-tax/nexus?format=csv"
            className={`px-3 py-1.5 rounded-lg text-sm border ${border} ${subText} hover:opacity-80`}
          >
            CSV
          </a>
          <a
            href="/api/sales-tax/nexus?format=xlsx"
            className={`px-3 py-1.5 rounded-lg text-sm border ${border} ${subText} hover:opacity-80`}
          >
            Excel
          </a>
        </div>
      </div>

      {/* Table */}
      <div className={`rounded-xl shadow-sm overflow-hidden ${cardBg}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={`${headBg} text-left ${subText}`}>
                <th className="px-4 py-3 font-semibold">State</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Gross (YTD)</th>
                <th className="px-4 py-3 font-semibold text-right">Txns (YTD)</th>
                <th className="px-4 py-3 font-semibold text-right">Projected FY</th>
                <th className="px-4 py-3 font-semibold">Threshold</th>
                <th className="px-4 py-3 font-semibold">Period / notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.abbr} r={r} dark={darkMode} border={border} subText={subText} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sources & references (interim, pending the CPA's determination) */}
      <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
        <p className="text-sm font-semibold mb-1">Sources &amp; references</p>
        <p className={`text-xs mb-3 ${subText}`}>
          Interim references backing the threshold table, pending the CPA&apos;s own nexus determination. Per-state
          primary sources (statute / DOR) are linked in the table&apos;s right-hand column where verified; the
          continuously-updated aggregators below cover every state and are appropriate for ongoing monitoring.
        </p>
        <ul className="space-y-1.5 text-sm">
          {NEXUS_SOURCES.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline hover:opacity-80">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
        <p className={`text-xs mt-3 ${subText}`}>
          Full write-up: <code>docs/tax-reference/economic-nexus-thresholds-by-state.md</code> (verified 2026-06-17,
          cross-checked across the above).
        </p>
      </div>

      {/* Unrecognized ship-to codes */}
      {data.unrecognized.length > 0 && (
        <p className={`text-xs ${subText}`}>
          Not scored (territories / military / blank ship-to):{' '}
          {data.unrecognized.map((u) => `${u.code} (${usd.format(u.gross)})`).join(', ')}.
        </p>
      )}
      <p className={`text-xs ${subText}`}>
        Feed as of {data.feedAsOf ? new Date(data.feedAsOf).toLocaleString() : 'n/a'}. Thresholds:{' '}
        docs/tax-reference/economic-nexus-thresholds-by-state.md (verified 2026-06-17).
      </p>
    </div>
  );
}

function Row({ r, dark, border, subText }: { r: NexusStateRow; dark: boolean; border: string; subText: string }) {
  const source = THRESHOLD_BY_ABBR[r.abbr]?.source;
  const projFlag = !r.overNow && r.overProjected;
  const thresholdText =
    !r.hasSalesTax
      ? '—'
      : [
          r.salesThreshold != null ? usd.format(r.salesThreshold) : null,
          r.txnThreshold != null ? `${int.format(r.txnThreshold)} txns` : null,
        ]
          .filter(Boolean)
          .join(r.combine === 'and' ? ' AND ' : ' OR ');

  return (
    <tr className={`border-t ${border}`}>
      <td className="px-4 py-3">
        <span className="font-medium">{r.name}</span> <span className={subText}>{r.abbr}</span>
        {r.salesBasis === 'taxable' && (
          <span className={`ml-2 text-[10px] uppercase font-semibold ${subText}`}>taxable-basis</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded border text-xs font-semibold ${statusClasses(r.status, dark)}`}>
          {STATUS_LABEL[r.status]}
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{usd.format(r.grossYtd)}</td>
      <td className="px-4 py-3 text-right tabular-nums">{int.format(r.txnsYtd)}</td>
      <td className="px-4 py-3 text-right tabular-nums">
        {usd.format(r.grossProjected)}
        {projFlag && <span className="ml-1 text-amber-500" title="Projected to cross threshold">▲</span>}
      </td>
      <td className="px-4 py-3">{thresholdText}</td>
      <td className={`px-4 py-3 text-xs ${subText}`}>
        {r.measurement}
        {r.note ? <span className="block mt-0.5">{r.note}</span> : null}
        {source ? (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-0.5 underline hover:opacity-80"
            title={source.label}
          >
            source ↗
          </a>
        ) : null}
      </td>
    </tr>
  );
}

function SummaryCard({
  cardBg,
  subText,
  label,
  value,
  accent,
}: {
  cardBg: string;
  subText: string;
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg}`}>
      <p className={`text-2xl font-bold ${accent}`}>{value}</p>
      <p className={`text-xs mt-1 ${subText}`}>{label}</p>
    </div>
  );
}
