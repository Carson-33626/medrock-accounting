'use client';

import { useEffect, useState } from 'react';
import type { LocationForecastResponse } from '@/types/location-analytics';
import type { ManualForecast } from '@/types/manual-forecast';
import { ManualForecastEditor } from './ManualForecastEditor';
import { METRIC_OPTIONS } from './chartTheme';

interface ManualForecastTabProps {
  forecast: LocationForecastResponse;
  darkMode: boolean;
  cardBg: string;
  subText: string;
  rowBorder: string;
}

function metricLabel(metric: string): string {
  return METRIC_OPTIONS.find((m) => m.key === metric)?.label ?? metric;
}

/**
 * Lists saved manual forecasts (GET) with Edit / Delete, and a "New" button that opens
 * `ManualForecastEditor`. Delete is a two-click inline confirm (no window.confirm — this
 * panel avoids browser-native dialogs to keep the theme/keyboard behavior consistent).
 */
export function ManualForecastTab({ forecast, darkMode, cardBg, subText, rowBorder }: ManualForecastTabProps) {
  const [items, setItems] = useState<ManualForecast[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ManualForecast | 'new' | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/location-analytics/manual-forecast');
      if (!res.ok) throw new Error(`Failed to load manual forecasts (${res.status})`);
      setItems((await res.json()) as ManualForecast[]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load manual forecasts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleDelete = async (id: number): Promise<void> => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/location-analytics/manual-forecast/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
      setConfirmDeleteId(null);
    }
  };

  if (editing) {
    return (
      <ManualForecastEditor
        forecast={forecast}
        darkMode={darkMode}
        cardBg={cardBg}
        subText={subText}
        rowBorder={rowBorder}
        existing={editing === 'new' ? null : editing}
        onSaved={(saved) => {
          setItems((prev) => {
            const idx = prev.findIndex((i) => i.id === saved.id);
            if (idx === -1) return [saved, ...prev];
            const next = [...prev];
            next[idx] = saved;
            return next;
          });
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className={`text-sm ${subText}`}>Manually entered forecasts, for comparison against the system projection.</p>
        <button
          onClick={() => setEditing('new')}
          className="px-4 py-2 text-sm font-medium rounded-lg text-white"
          style={{ backgroundColor: '#5e3b8d' }}
        >
          + New
        </button>
      </div>

      {loadError && (
        <div className={`rounded-xl p-3 text-xs border border-red-400 text-red-500 ${cardBg}`}>{loadError}</div>
      )}

      {loading ? (
        <div className={`rounded-xl shadow-sm p-8 text-center ${cardBg} ${subText}`}>Loading…</div>
      ) : items.length === 0 ? (
        <div className={`rounded-xl shadow-sm p-8 text-center ${cardBg} ${subText}`}>
          No manual forecasts yet. Click &ldquo;+ New&rdquo; to create one.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className={`rounded-xl shadow-sm p-4 flex items-center justify-between ${cardBg}`}>
              <div>
                <p className="text-sm font-semibold">{item.name}</p>
                <p className={`text-xs ${subText}`}>
                  {metricLabel(item.metric)} · {item.basis} · {item.entries.length} entries
                  {item.createdBy ? ` · by ${item.createdBy}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {confirmDeleteId === item.id ? (
                  <>
                    <span className={`text-xs ${subText}`}>Delete &ldquo;{item.name}&rdquo;?</span>
                    <button
                      onClick={() => void handleDelete(item.id)}
                      disabled={deleting}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg text-white bg-red-600 disabled:opacity-50"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={deleting}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${rowBorder} disabled:opacity-50`}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setEditing(item)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${rowBorder}`}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(item.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-400 text-red-500"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
