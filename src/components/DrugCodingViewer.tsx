'use client';

import { useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';

export interface DrugRow {
  id: string;
  name: string;
  sort: string;
  form: string;
  units: string;
  category: string;
  ndc: string | null;
}

type SortKey = 'id' | 'name' | 'ndc' | 'form' | 'units' | 'category';
type SortDir = 'asc' | 'desc';

interface DrugCodingViewerProps {
  rows: DrugRow[];
  loadError?: string | null;
}

export default function DrugCodingViewer({ rows, loadError = null }: DrugCodingViewerProps) {
  const { darkMode } = useDarkMode();

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [form, setForm] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // De-dupe defensively on LifeFile ID (the DB view already de-dupes, but guard anyway).
  const data = useMemo(() => {
    const seen = new Set<string>();
    const out: DrugRow[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out;
  }, [rows]);

  const categories = useMemo(
    () => Array.from(new Set(data.map((r) => r.category).filter(Boolean))).sort(),
    [data],
  );

  const forms = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of data) {
      const key = r.form.toLowerCase();
      if (r.form && !seen.has(key)) seen.set(key, r.form);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of data) counts[r.category] = (counts[r.category] ?? 0) + 1;
    return counts;
  }, [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = data.filter((row) => {
      if (category !== 'all' && row.category !== category) return false;
      if (form !== 'all' && row.form.toLowerCase() !== form.toLowerCase()) return false;
      if (
        q &&
        !row.name.toLowerCase().includes(q) &&
        !row.id.toLowerCase().includes(q) &&
        !(row.ndc ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      if (sortKey === 'id') return (Number(a.id) - Number(b.id)) * dir;
      if (sortKey === 'ndc') {
        // null/empty NDCs sort to the bottom regardless of direction
        const av = a.ndc ?? '';
        const bv = b.ndc ?? '';
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return av.localeCompare(bv) * dir;
      }
      return a[sortKey].localeCompare(b[sortKey]) * dir;
    });
    return out;
  }, [data, search, category, form, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 1200);
    } catch {
      /* clipboard unavailable - ignore */
    }
  };

  const resetFilters = () => {
    setSearch('');
    setCategory('all');
    setForm('all');
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

  const categoryBadge = (value: string) => {
    if (value === 'Commercial Rx') {
      return darkMode
        ? 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30'
        : 'bg-blue-50 text-blue-700 ring-1 ring-blue-200';
    }
    return darkMode
      ? 'bg-purple-500/15 text-purple-300 ring-1 ring-purple-500/30'
      : 'bg-purple-50 text-purple-700 ring-1 ring-purple-200';
  };

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : '');

  const headerCell = (key: SortKey, label: string, extra = '') => (
    <th
      onClick={() => toggleSort(key)}
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider cursor-pointer select-none whitespace-nowrap ${extra}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className="text-[10px] text-purple-500">{sortArrow(key)}</span>
      </span>
    </th>
  );

  const copyCell = (value: string | null, key: string) =>
    value ? (
      <button
        onClick={() => copy(value, key)}
        title="Copy"
        className={`font-mono text-xs inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 transition ${copyBtn}`}
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
      <div className="max-w-7xl mx-auto p-4 md:p-8">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl md:text-3xl font-bold">Drug Coding Reference</h1>
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-600 text-white">2026</span>
          </div>
          <p className={`mt-1 text-sm ${subtle}`}>
            LifeFile — Commercial Rx &amp; Compound Ingredient. Look up the LifeFile ID, NDC, form and
            QuickBooks category for each drug.
          </p>
        </div>

        {loadError && (
          <div className="mb-6 rounded-xl border border-red-300 bg-red-50 text-red-700 px-4 py-3 text-sm">
            Couldn&apos;t load drug coding data: {loadError}. Make sure the
            <code className="mx-1 font-mono">accounting_drug_coding_view</code> migration has been run.
          </div>
        )}

        {/* Stat chips (click to filter by category) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
          <button
            onClick={() => setCategory('all')}
            className={`text-left rounded-xl border p-4 transition ${card} ${
              category === 'all' ? 'ring-2 ring-purple-500' : ''
            }`}
          >
            <div className={`text-xs uppercase tracking-wide ${subtle}`}>Total Drugs</div>
            <div className="text-2xl font-bold mt-1">{data.length.toLocaleString()}</div>
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`text-left rounded-xl border p-4 transition ${card} ${
                category === cat ? 'ring-2 ring-purple-500' : ''
              }`}
            >
              <div className={`text-xs uppercase tracking-wide ${subtle}`}>{cat}</div>
              <div className="text-2xl font-bold mt-1">{(categoryCounts[cat] ?? 0).toLocaleString()}</div>
            </button>
          ))}
        </div>

        {/* Toolbar */}
        <div className={`rounded-xl border p-4 mb-4 ${card}`}>
          <div className="flex flex-col md:flex-row gap-3 md:items-center">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by drug name, LifeFile ID or NDC…"
              className={`flex-1 rounded-lg border px-4 py-2.5 text-sm outline-none transition ${inputCls}`}
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={`rounded-lg border px-3 py-2.5 text-sm outline-none transition ${inputCls}`}
            >
              <option value="all">All QB Categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
            <select
              value={form}
              onChange={(e) => setForm(e.target.value)}
              className={`rounded-lg border px-3 py-2.5 text-sm outline-none transition ${inputCls}`}
            >
              <option value="all">All Forms</option>
              {forms.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button
              onClick={resetFilters}
              className={`rounded-lg px-4 py-2.5 text-sm font-medium transition ${
                darkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
              }`}
            >
              Reset
            </button>
          </div>
          <div className={`mt-3 text-xs ${subtle}`}>
            Showing <span className="font-semibold text-purple-500">{filtered.length.toLocaleString()}</span> of{' '}
            {data.length.toLocaleString()} drugs
          </div>
        </div>

        {/* Table */}
        <div className={`rounded-xl border overflow-hidden ${card}`}>
          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className={`sticky top-0 z-10 ${headCls}`}>
                <tr>
                  {headerCell('id', 'LifeFile ID')}
                  {headerCell('name', 'Drug Name', 'w-full')}
                  {headerCell('ndc', 'NDC')}
                  {headerCell('form', 'Form')}
                  {headerCell('units', 'Units')}
                  {headerCell('category', 'QB Category')}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id} className={`border-t ${rowBorder} ${rowHover} transition-colors`}>
                    <td className="px-4 py-2.5 whitespace-nowrap">{copyCell(row.id, `id-${row.id}`)}</td>
                    <td className="px-4 py-2.5 font-medium">{row.name}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">{copyCell(row.ndc, `ndc-${row.id}`)}</td>
                    <td className={`px-4 py-2.5 whitespace-nowrap ${subtle}`}>{row.form}</td>
                    <td className={`px-4 py-2.5 whitespace-nowrap ${subtle}`}>{row.units}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${categoryBadge(row.category)}`}>
                        {row.category}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className={`py-16 text-center text-sm ${subtle}`}>
                No drugs match your filters.{' '}
                <button onClick={resetFilters} className="text-purple-500 underline">
                  Reset
                </button>
              </div>
            )}
          </div>
        </div>

        <p className={`mt-4 text-xs ${subtle}`}>
          Source: LifeFile export &ldquo;To Code CommRX &amp; Comp Ingredient 2026&rdquo;. NDC joined live from
          <code className="mx-1 font-mono">lifefile_products</code>. Click a LifeFile ID or NDC to copy it.
        </p>
      </div>
    </div>
  );
}
