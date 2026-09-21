'use client';

import { useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import RegionsMap, { type MapFilter } from '@/components/RegionsMap';
import { REGION_GEO } from '@/lib/region-geo';
import { US_STATE_PATHS } from '@/lib/us-map-paths';

export interface RegionRow {
  id: string;
  region: string;
  holder: string | null;
  jobTitle: string | null;
  /** ADP status — "Active", "Leave", "Terminated". Null when the region is open. */
  status: string | null;
  /** Pharmacy the rep services — FL / TN / TX from ADP home_location. Null when open. */
  location: string | null;
  email: string | null;
  phone: string | null;
}

interface RegionsTableProps {
  rows: RegionRow[];
  loadError?: string | null;
}

export default function RegionsTable({ rows, loadError = null }: RegionsTableProps) {
  const { darkMode } = useDarkMode();
  const [search, setSearch] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [mapFilter, setMapFilter] = useState<MapFilter>(null);

  const assigned = rows.filter((r) => r.holder !== null).length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (mapFilter?.kind === 'region' && r.id !== mapFilter.id) return false;
      if (mapFilter?.kind === 'state' && !(REGION_GEO[r.region]?.states ?? []).includes(mapFilter.code)) return false;
      if (!q) return true;
      return [r.region, r.holder, r.location, r.email, r.phone].some((v) => (v ?? '').toLowerCase().includes(q));
    });
  }, [rows, search, mapFilter]);

  // Regions with no spot on the map (e.g. Remote) — named under the map so they aren't missed.
  const offMap = rows.filter((r) => REGION_GEO[r.region] === undefined).map((r) => r.region);

  const filterLabel =
    mapFilter === null
      ? null
      : mapFilter.kind === 'state'
        ? US_STATE_PATHS[mapFilter.code]?.name ?? mapFilter.code
        : rows.find((r) => r.id === mapFilter.id)?.region ?? 'Region';

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 1200);
    } catch {
      /* clipboard unavailable - ignore */
    }
  };

  // ── theme helpers (matches the app's boolean dark-mode pattern) ──
  const page = darkMode ? 'bg-slate-950 text-slate-100' : 'bg-gray-50 text-gray-900';
  const card = darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-200';
  const subtle = darkMode ? 'text-slate-400' : 'text-gray-500';
  const inputCls = darkMode
    ? 'bg-slate-800 border-slate-700 text-slate-100 placeholder-slate-500 focus:border-purple-500'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-purple-500';
  const headCls = darkMode ? 'bg-slate-800 text-slate-300' : 'bg-gray-100 text-gray-600';
  const rowBorder = darkMode ? 'border-slate-800' : 'border-gray-100';
  const rowHover = darkMode ? 'hover:bg-slate-800/60' : 'hover:bg-purple-50/60';
  const copyBtn = darkMode ? 'hover:bg-slate-700 text-slate-200' : 'hover:bg-gray-100 text-gray-700';
  const openBadge = darkMode
    ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
    : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200';
  const statusBadge = darkMode
    ? 'bg-slate-700 text-slate-300'
    : 'bg-gray-100 text-gray-600';

  const copyCell = (value: string | null, key: string) =>
    value ? (
      <button
        onClick={() => copy(value, key)}
        title="Copy"
        className={`text-xs inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 transition ${copyBtn}`}
      >
        {value}
        <span className={`text-[10px] ${copiedKey === key ? 'text-green-500' : 'text-purple-400'}`}>
          {copiedKey === key ? '✓' : '⧉'}
        </span>
      </button>
    ) : (
      <span className={subtle}>—</span>
    );

  return (
    <div className={`min-h-screen ${page}`}>
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <div className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">Regions</h1>
          <p className={`mt-1 text-sm ${subtle}`}>
            Marketer regions and who covers each one. Read-only — regions are added and assigned in the
            MedRock auth admin (Territories tab).
          </p>
        </div>

        {loadError && (
          <div className="mb-6 rounded-xl border border-red-300 bg-red-50 text-red-700 px-4 py-3 text-sm">
            Couldn&apos;t load regions: {loadError}
          </div>
        )}

        <div className={`rounded-xl border ${card} p-4 mb-4`}>
          <div className="max-w-2xl mx-auto">
            <RegionsMap regions={rows} filter={mapFilter} onFilter={setMapFilter} darkMode={darkMode} />
          </div>
          <p className={`mt-2 text-xs text-center ${subtle}`}>
            Click a state or a metro dot to filter the table; click it again to clear.
            {offMap.length > 0 && <> Not on the map: {offMap.join(', ')}.</>}
          </p>
        </div>

        <div className={`rounded-xl border ${card} p-4 mb-4 flex flex-wrap items-center gap-3`}>
          <div className={`text-sm ${subtle}`}>
            <span className="font-semibold">{rows.length}</span> regions ·{' '}
            <span className="font-semibold text-green-600">{assigned}</span> assigned ·{' '}
            <span className="font-semibold text-amber-600">{rows.length - assigned}</span> open
          </div>
          {filterLabel && (
            <button
              onClick={() => setMapFilter(null)}
              title="Clear the map filter"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-600 text-white hover:bg-purple-700"
            >
              {filterLabel}
              <span aria-hidden>×</span>
            </button>
          )}
          <div className="flex-1" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search region, name, email…"
            className={`border rounded-lg px-3 py-2 text-sm w-full sm:w-72 focus:outline-none ${inputCls}`}
          />
        </div>

        <div className={`rounded-xl border ${card} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead>
              <tr className={headCls}>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">Region</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">Assigned to</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">Location</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">Email</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">Phone</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className={`border-t ${rowBorder} ${rowHover}`}>
                  <td className="px-4 py-2.5 font-medium whitespace-nowrap">{r.region}</td>
                  <td className="px-4 py-2.5">
                    {r.holder ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{r.holder}</span>
                        {r.status && r.status !== 'Active' && (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${statusBadge}`}>
                            {r.status}
                          </span>
                        )}
                        {r.jobTitle && <span className={`text-xs ${subtle}`}>{r.jobTitle}</span>}
                      </div>
                    ) : (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${openBadge}`}>Open</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {r.location ? (
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusBadge}`}>{r.location}</span>
                    ) : (
                      <span className={subtle}>—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{copyCell(r.email, `${r.id}:email`)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{copyCell(r.phone, `${r.id}:phone`)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className={`px-4 py-10 text-center ${subtle}`}>
                    {rows.length === 0 ? 'No regions found.' : 'No regions match that filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
