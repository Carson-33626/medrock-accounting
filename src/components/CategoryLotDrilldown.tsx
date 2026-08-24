'use client';

import { useEffect, useState } from 'react';
import type { LotsResponse, ProductGroupRow } from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const qty = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * The products/lots behind one category line of the close entry, fetched lazily
 * on first expand (mirrors JournalGrid's per-line payroll drill-down).
 *
 * Reads /api/inventory/lots with the SAME (location, category, month) filter the
 * close used to total that line — so what a reviewer sees here always foots to
 * the line above it. No new endpoint: this is the Inventory Valuation page's
 * existing product grouping, filtered.
 */
export default function CategoryLotDrilldown({
  location,
  qbCategory,
  month,
  darkMode,
}: {
  location: string;
  qbCategory: string;
  month: string;
  darkMode: boolean;
}) {
  const [rows, setRows] = useState<ProductGroupRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      location,
      category: qbCategory,
      status: 'all',
      month,
      limit: '250',
      offset: '0',
      sort: 'remaining_value',
      dir: 'desc',
    });
    fetch(`/api/inventory/lots?${params.toString()}`)
      .then((r) => r.json() as Promise<LotsResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('error' in data) setError(data.error);
        else {
          setRows(data.rows);
          setTotal(data.total);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load lots');
      });
    return () => {
      cancelled = true;
    };
  }, [location, qbCategory, month]);

  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  if (error) return <p className="text-xs text-red-600 px-2 py-2">{error}</p>;
  if (rows === null) return <p className={`text-xs px-2 py-2 ${subText}`}>Loading lots…</p>;
  if (rows.length === 0) {
    return <p className={`text-xs px-2 py-2 ${subText}`}>No lots for this category in {month}.</p>;
  }

  const shown = rows.reduce((s, r) => s + (r.remaining_value ?? 0), 0);

  return (
    <div className="px-2 py-2 space-y-2">
      <p className={`text-xs ${subText}`}>
        {total.toLocaleString()} products · {usd.format(shown)} shown
        {total > rows.length ? ` (first ${rows.length} by value)` : ''} ·{' '}
        <a
          href={`/api/inventory/lots?location=${encodeURIComponent(location)}&category=${encodeURIComponent(qbCategory)}&status=all&month=${encodeURIComponent(month)}&format=xlsx`}
          className="underline font-medium"
        >
          Excel (every lot)
        </a>
      </p>
      <div className="overflow-x-auto max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className={subText}>
              <th className="text-left py-1 pr-3 font-medium">Product</th>
              <th className="text-left py-1 pr-3 font-medium">NDC</th>
              <th className="text-right py-1 pr-3 font-medium">Lots</th>
              <th className="text-left py-1 pr-3 font-medium">Last Received</th>
              <th className="text-right py-1 pr-3 font-medium">Remaining</th>
              <th className="text-right py-1 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product_key} className={`border-t ${border}`}>
                <td className="py-1 pr-3">{r.product_name ?? r.product_key}</td>
                <td className={`py-1 pr-3 ${subText}`}>{r.ndc ?? '—'}</td>
                <td className="py-1 pr-3 text-right">{r.lot_count}</td>
                <td className="py-1 pr-3">{r.last_received ?? '—'}</td>
                <td className="py-1 pr-3 text-right">{qty.format(r.qty_remaining)}</td>
                <td className="py-1 text-right tabular-nums">
                  {r.remaining_value !== null ? usd.format(r.remaining_value) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
