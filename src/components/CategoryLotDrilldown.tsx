'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import FifoQueue from './FifoQueue';
import type { LotsResponse, ProductDetailResponse, ProductGroupRow } from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const qty = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * The lots route's own ceiling. Set to the maximum on purpose: this table is a
 * substantiation, so a reviewer has to be able to add it up to the line above
 * it. At 250 (the previous value) Florida's Commercial Rx showed $110,652.65 of
 * a $111,695.04 line and there was no way to see the difference on screen. The
 * count and the "first N by value" caption below still tell the truth if a
 * category ever exceeds this.
 */
const PRODUCT_LIMIT = 1000;

/**
 * The products behind one (location, category, month) cell — and, one click
 * further down, the individual purchase receipts behind each product.
 *
 * Two levels, because that is the chain a CPA has to walk to sign off: posted
 * entry -> category -> product -> receipt. It reads /api/inventory/lots with the
 * SAME filter the close used to total that line, so what appears here always
 * foots to the line above it.
 *
 * Shared by the inventory-close JE panel and the point-in-time page. Both show
 * the same evidence for the same cell — that is the whole point of the two
 * screens agreeing, so it must not be forked.
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

  const [openKey, setOpenKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** The product whose receipts we are currently waiting on — see toggleProduct. */
  const activeRequest = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      location,
      category: qbCategory,
      status: 'all',
      month,
      limit: String(PRODUCT_LIMIT),
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

  // Changing the cell must drop any open product — otherwise the receipts of a
  // product from the PREVIOUS category stay on screen under the new one.
  useEffect(() => {
    activeRequest.current = null;
    setOpenKey(null);
    setDetail(null);
    setDetailError(null);
  }, [location, qbCategory, month]);

  const toggleProduct = useCallback(
    (productKey: string) => {
      if (openKey === productKey) {
        activeRequest.current = null;
        setOpenKey(null);
        setDetail(null);
        setDetailError(null);
        return;
      }
      activeRequest.current = productKey;
      setOpenKey(productKey);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      // `month` is load-bearing: without it this route answers for the latest
      // month, so a March close would be substantiated with August receipts.
      const params = new URLSearchParams({ key: productKey, location, month });
      fetch(`/api/inventory/product?${params.toString()}`)
        .then((r) => r.json() as Promise<ProductDetailResponse | { error: string }>)
        .then((data) => {
          // A slow response for a product the user has since collapsed or
          // switched away from must not overwrite what is on screen. The guard
          // is a ref, not a state updater — updaters have to stay pure.
          if (activeRequest.current !== productKey) return;
          if ('error' in data) setDetailError(data.error);
          else setDetail(data);
        })
        .catch((e: unknown) => {
          if (activeRequest.current !== productKey) return;
          setDetailError(e instanceof Error ? e.message : 'Failed to load receipts');
        })
        .finally(() => {
          if (activeRequest.current === productKey) setDetailLoading(false);
        });
    },
    [openKey, location, month],
  );

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
        {total > rows.length ? ` (first ${rows.length} by value)` : ''} · click a product for its purchase
        receipts ·{' '}
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
              <Fragment key={r.product_key}>
                <tr
                  onClick={() => toggleProduct(r.product_key)}
                  className={`border-t cursor-pointer ${border} ${
                    darkMode ? 'hover:bg-slate-700/50' : 'hover:bg-slate-100'
                  }`}
                >
                  <td className="py-1 pr-3">
                    <span className="flex items-center gap-1">
                      {openKey === r.product_key ? (
                        <ChevronDown className="w-3 h-3 shrink-0" aria-hidden />
                      ) : (
                        <ChevronRight className="w-3 h-3 shrink-0" aria-hidden />
                      )}
                      {r.product_name ?? r.product_key}
                    </span>
                  </td>
                  <td className={`py-1 pr-3 ${subText}`}>{r.ndc ?? '—'}</td>
                  <td className="py-1 pr-3 text-right">{r.lot_count}</td>
                  <td className="py-1 pr-3">{r.last_received ?? '—'}</td>
                  <td className="py-1 pr-3 text-right">{qty.format(r.qty_remaining)}</td>
                  <td className="py-1 text-right tabular-nums">
                    {r.remaining_value !== null ? usd.format(r.remaining_value) : '—'}
                  </td>
                </tr>
                {openKey === r.product_key && (
                  <tr>
                    <td colSpan={6} className={`px-3 py-3 ${darkMode ? 'bg-slate-900/50' : 'bg-white'}`}>
                      {detailLoading && <p className={`text-xs ${subText}`}>Loading purchase receipts…</p>}
                      {detailError && <p className="text-xs text-red-600">{detailError}</p>}
                      {detail && <FifoQueue detail={detail} rowBorder={border} subText={subText} />}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
