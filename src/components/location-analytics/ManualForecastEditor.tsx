'use client';

import { useState } from 'react';
import type { Basis, LocationForecastResponse, TrendMetric } from '@/types/location-analytics';
import type { ManualForecast, ManualForecastEntry, ManualForecastInput } from '@/types/manual-forecast';
import { parseClipboard } from '@/lib/forecast/manual-forecast-paste';
import { skToYm, fmtMonth } from '@/lib/forecast/engine';
import { METRIC_OPTIONS } from './chartTheme';

/** location -> 'YYYY-MM' -> amount. Cells with no entry are simply absent from the inner map. */
type Grid = Record<string, Record<string, number>>;

const BASIS_OPTIONS: readonly Basis[] = ['Cash', 'Accrual'];

function skToMonth(sortKey: number): string {
  const { y, m } = skToYm(sortKey);
  return fmtMonth(m, y);
}

function monthToSk(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return y * 100 + m;
}

/** Adds `n` calendar months to a 'YYYY-MM' string. */
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function buildRange(startYm: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addMonths(startYm, i));
}

function gridFromEntries(entries: ManualForecastEntry[]): Grid {
  const g: Grid = {};
  for (const e of entries) {
    const ym = skToMonth(e.sortKey);
    if (!g[e.location]) g[e.location] = {};
    g[e.location][ym] = e.amount;
  }
  return g;
}

interface ManualForecastEditorProps {
  forecast: LocationForecastResponse;
  darkMode: boolean;
  cardBg: string;
  subText: string;
  rowBorder: string;
  /** null = creating a new manual forecast; otherwise the one being edited. */
  existing: ManualForecast | null;
  onSaved: (saved: ManualForecast) => void;
  onCancel: () => void;
}

/**
 * `[location] x [month]` amount grid for one manual forecast (name + metric + basis).
 * Supports a raw-Excel paste (month+amount pairs, or an amounts-only column filled down
 * onto the visible months) via `parseClipboard`, plus a "+12 months" range extender.
 * Saves via POST (new) / PUT (existing) against the manual-forecast CRUD routes.
 */
export function ManualForecastEditor({
  forecast,
  darkMode,
  cardBg,
  subText,
  rowBorder,
  existing,
  onSaved,
  onCancel,
}: ManualForecastEditorProps) {
  const locations = forecast.series.map((s) => ({ qbLocation: s.qbLocation, label: s.label }));

  const [name, setName] = useState<string>(existing?.name ?? '');
  const [metric, setMetric] = useState<TrendMetric>(existing?.metric ?? 'revenue');
  const [basis, setBasis] = useState<Basis>(existing?.basis ?? forecast.basis);
  const [selectedLocation, setSelectedLocation] = useState<string>(
    existing?.entries[0]?.location ?? locations[0]?.qbLocation ?? '',
  );

  const [months, setMonths] = useState<string[]>(() => {
    if (existing && existing.entries.length) {
      const set = new Set(existing.entries.map((e) => skToMonth(e.sortKey)));
      return Array.from(set).sort();
    }
    const lastHistory = forecast.months[forecast.months.length - 1] ?? `${new Date().getFullYear()}-01`;
    return buildRange(addMonths(lastHistory, 1), 12);
  });

  const [grid, setGrid] = useState<Grid>(() => (existing ? gridFromEntries(existing.entries) : {}));

  const [pasteText, setPasteText] = useState<string>('');
  const [pasteErrors, setPasteErrors] = useState<string[]>([]);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState<boolean>(false);

  const inputCls = `w-28 px-2 py-1 text-xs text-right rounded border ${rowBorder} ${
    darkMode ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900'
  }`;
  const toggleBase = (active: boolean): string =>
    `px-3 py-1.5 text-xs font-medium transition-colors ${
      active ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
    }`;

  const setCell = (location: string, ym: string, amount: number | undefined): void => {
    setGrid((prev) => {
      const nextLoc = { ...(prev[location] ?? {}) };
      if (amount === undefined || Number.isNaN(amount)) {
        delete nextLoc[ym];
      } else {
        nextLoc[ym] = amount;
      }
      return { ...prev, [location]: nextLoc };
    });
  };

  const handleAddMonths = (): void => {
    setMonths((prev) => {
      const last = prev[prev.length - 1] ?? `${new Date().getFullYear()}-01`;
      return [...prev, ...buildRange(addMonths(last, 1), 12)];
    });
  };

  const handleApplyPaste = (): void => {
    const result = parseClipboard(pasteText);
    setPasteErrors(result.errors);
    if (!selectedLocation) return;

    if (result.kind === 'pairs') {
      const pairs = result.pairs;
      setMonths((prevMonths) => {
        const monthSet = new Set(prevMonths);
        for (const p of pairs) monthSet.add(skToMonth(p.sortKey));
        return Array.from(monthSet).sort();
      });
      setGrid((prev) => {
        const nextLoc = { ...(prev[selectedLocation] ?? {}) };
        for (const p of pairs) nextLoc[skToMonth(p.sortKey)] = p.amount;
        return { ...prev, [selectedLocation]: nextLoc };
      });
    } else if (result.kind === 'amounts') {
      const amounts = result.amounts;
      setGrid((prev) => {
        const nextLoc = { ...(prev[selectedLocation] ?? {}) };
        amounts.forEach((amount, i) => {
          const ym = months[i];
          if (ym) nextLoc[ym] = amount;
        });
        return { ...prev, [selectedLocation]: nextLoc };
      });
    }
  };

  const handleSave = async (): Promise<void> => {
    setSaveErrors([]);
    if (!name.trim()) {
      setSaveErrors(['Name is required']);
      return;
    }

    const entries: ManualForecastEntry[] = [];
    for (const location of Object.keys(grid)) {
      for (const [ym, amount] of Object.entries(grid[location] ?? {})) {
        entries.push({ location, sortKey: monthToSk(ym), amount });
      }
    }
    const input: ManualForecastInput = { name: name.trim(), metric, basis, entries };

    setSaving(true);
    try {
      const url = existing
        ? `/api/location-analytics/manual-forecast/${existing.id}`
        : '/api/location-analytics/manual-forecast';
      const res = await fetch(url, {
        method: existing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      if (res.status === 400) {
        const body = (await res.json()) as { errors: string[] };
        setSaveErrors(body.errors);
        return;
      }
      if (res.status === 409) {
        const body = (await res.json()) as { error: string };
        setSaveErrors([body.error]);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveErrors([body.error ?? `Save failed (${res.status})`]);
        return;
      }

      const saved = (await res.json()) as ManualForecast;
      onSaved(saved);
    } catch (err) {
      setSaveErrors([err instanceof Error ? err.message : 'Save failed']);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`rounded-xl shadow-sm p-4 space-y-4 ${cardBg}`}>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <span className={`text-xs uppercase tracking-wide ${subText}`}>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. FY27 Budget"
            className={`px-3 py-2 text-sm rounded-lg border ${rowBorder} ${
              darkMode ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900'
            }`}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs uppercase tracking-wide ${subText}`}>Metric</span>
          <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
            {METRIC_OPTIONS.map((m) => (
              <button
                key={m.key}
                onClick={() => setMetric(m.key)}
                className={toggleBase(metric === m.key)}
                style={metric === m.key ? { backgroundColor: '#5e3b8d' } : undefined}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs uppercase tracking-wide ${subText}`}>Basis</span>
          <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
            {BASIS_OPTIONS.map((b) => (
              <button
                key={b}
                onClick={() => setBasis(b)}
                className={toggleBase(basis === b)}
                style={basis === b ? { backgroundColor: '#5e3b8d' } : undefined}
              >
                {b}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Paste from Excel */}
      <div className={`rounded-lg border p-3 space-y-2 ${rowBorder}`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={`text-xs uppercase tracking-wide ${subText}`}>Paste from Excel</span>
          {locations.length > 1 && (
            <div className="flex items-center gap-2">
              <span className={`text-xs ${subText}`}>into</span>
              <select
                value={selectedLocation}
                onChange={(e) => setSelectedLocation(e.target.value)}
                className={`px-2 py-1 text-xs rounded-lg border ${rowBorder} ${cardBg}`}
              >
                {locations.map((l) => (
                  <option key={l.qbLocation} value={l.qbLocation}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={'2026-08\t500000\n2026-09\t520000\n...\n\nor a single amounts column, filled down onto the visible months'}
          rows={3}
          className={`w-full px-3 py-2 text-xs font-mono rounded-lg border ${rowBorder} ${
            darkMode ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900'
          }`}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={handleApplyPaste}
            disabled={!pasteText.trim() || !selectedLocation}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${rowBorder} disabled:opacity-50`}
          >
            Apply paste
          </button>
          <button onClick={handleAddMonths} className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${rowBorder}`}>
            +12 months
          </button>
        </div>
        {pasteErrors.length > 0 && (
          <ul className="text-xs text-red-500 list-disc pl-5 space-y-0.5">
            {pasteErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Grid */}
      <div className="overflow-x-auto max-h-96 overflow-y-auto">
        <table className="text-xs">
          <thead>
            <tr className={darkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}>
              <th className="px-3 py-2 text-left font-medium sticky left-0">Month</th>
              {locations.map((l) => (
                <th key={l.qbLocation} className="px-3 py-2 text-right font-medium">
                  {l.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {months.map((ym) => (
              <tr key={ym} className={`border-t ${rowBorder}`}>
                <td className="px-3 py-2 text-left font-medium sticky left-0">{ym}</td>
                {locations.map((l) => (
                  <td key={l.qbLocation} className="px-3 py-2 text-right">
                    <input
                      type="number"
                      value={grid[l.qbLocation]?.[ym] ?? ''}
                      onChange={(e) =>
                        setCell(l.qbLocation, ym, e.target.value === '' ? undefined : Number(e.target.value))
                      }
                      className={inputCls}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {saveErrors.length > 0 && (
        <ul className="text-xs text-red-500 list-disc pl-5 space-y-0.5">
          {saveErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-50"
          style={{ backgroundColor: '#5e3b8d' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className={`px-4 py-2 text-sm font-medium rounded-lg border ${rowBorder}`}>
          Cancel
        </button>
      </div>
    </div>
  );
}
