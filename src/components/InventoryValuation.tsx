'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import Explainer from './Explainer';
import HelpTip from './HelpTip';
import FifoQueue from './FifoQueue';
import { monthDates } from '@/lib/inventory/month-dates';
import { shortInventoryLocation } from '@/lib/inventory/monthly-close';
import { InventoryMethodology } from '@/app/payroll/components/InventoryMethodology';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import type {
  AsOfResponse,
  Basis,
  LotsResponse,
  ProductDetailResponse,
  ProductGroupRow,
  RollbackResponse,
  RollbackValuationRow,
  SummaryResponse,
} from '@/types/inventory';

const PAGE_SIZE = 50;

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const qty = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const CATEGORY_COLORS: Record<string, string> = {
  'Commercial Rx': '#2563eb',
  'Compound Ingredient': '#5e3b8d',
  'Lab Compound Packaging Inventory': '#0891b2',
  'Lab Supplies': '#be123c',
  Uncoded: '#d97706',
  'Opening Balance': '#64748b',
};

function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? '#94a3b8';
}

type SortDir = 'asc' | 'desc';

const BRAND_PURPLE = '#5e3b8d';

/** One (month, location, category) cell, normalized so nothing downstream
 *  branches on which basis it came from. */
interface Cell {
  month: string;
  location: string;
  qbCategory: string;
  value: number;
  /** null on cash basis, which has no lot grain. */
  lotCount: number | null;
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

interface LotColumn {
  key: string;
  label: string;
  align: 'left' | 'right';
  /** Numeric/value columns open on descending — that's the useful direction */
  defaultDesc?: boolean;
  /** Mouseover "?" explanation shown next to the column header */
  help?: string;
}

const LOT_COLUMNS: LotColumn[] = [
  { key: 'product_name', label: 'Product', align: 'left' },
  { key: 'qb_category', label: 'Category', align: 'left', help: 'The QuickBooks category this product’s purchases are coded to.' },
  { key: 'locations', label: 'Locations', align: 'left' },
  {
    key: 'lot_count',
    label: 'Lots',
    align: 'right',
    defaultDesc: true,
    help: 'Purchase receipts behind this product — each receipt is one lot. “Open” lots still hold quantity.',
  },
  { key: 'last_received', label: 'Last Received', align: 'left' },
  {
    key: 'qty_consumed',
    label: 'Consumed',
    align: 'right',
    defaultDesc: true,
    help: 'Units drawn out of this product’s lots: dispensing, use in compounding, and reconciliation write-downs against LifeFile.',
  },
  {
    key: 'qty_remaining',
    label: 'Remaining',
    align: 'right',
    defaultDesc: true,
    help: 'Units still on hand across this product’s open lots.',
  },
  {
    key: 'remaining_value',
    label: 'Value Left',
    align: 'right',
    defaultDesc: true,
    help: 'Remaining units valued at the actual purchase price of the lots they sit in. This column is what sums to the on-hand total.',
  },
  {
    key: 'open_lots',
    label: 'Status',
    align: 'left',
    help: '“Fully used” means every lot for this product is exhausted; “open” means stock remains.',
  },
];

/**
 * FIFO inventory valuation for ANY month-end — one page, driven by the month
 * picker at the top.
 *
 * This used to be two screens: this one, pinned to the latest month, and a
 * separate "Point-in-Time" page for everything earlier. They read different
 * tables and disagreed, and the split invited exactly the comparison that made
 * that visible: a $1.9M figure on one against $1.0M on the other, which turned
 * out to be two different months AND two different methods. Now every figure —
 * headline, breakdowns, trend, product table, receipts — comes off the same lot
 * ledger for whichever month is selected, and moving the picker moves all of it.
 */
export default function InventoryValuation() {
  const { darkMode } = useDarkMode();

  const [basis, setBasis] = useState<Basis>('accrual');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [asOf, setAsOf] = useState<AsOfResponse | null>(null);
  const [rollbackRows, setRollbackRows] = useState<RollbackValuationRow[]>([]);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [month, setMonth] = useState<string | null>(null);
  const [location, setLocation] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  /** Set when we arrived from the Inventory Close tab, so we can offer a way back. */
  const [fromClose, setFromClose] = useState(false);
  /** Trend window: focused on the last 90 days by default; 'all' shows the full
   *  history including the pre-anchor era and its discharge step. */
  const [chartRange, setChartRange] = useState<'90d' | 'all'>('90d');
  /** Chart series the user has toggled AWAY from their default visibility.
   *  Defaults: Total, Reconstruction and the three location lines ON (the
   *  comparison view); category lines OFF until toggled — they are the clutter. */
  const [toggledSeries, setToggledSeries] = useState<ReadonlySet<string>>(new Set());
  /** Sub-tabs: the valuation itself vs. the same Methodology & evidence view the
   *  Inventory Close tab shows — ONE component, referenced from both sides. */
  const [pageTab, setPageTab] = useState<'valuation' | 'method'>('valuation');

  const [lots, setLots] = useState<LotsResponse | null>(null);
  const [lotsLoading, setLotsLoading] = useState(false);
  const [lotsError, setLotsError] = useState<string | null>(null);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Deep link, read post-hydration so the server and first client render agree.
  // This is what the close's category rows link to:
  // /inventory?month=2026-03&location=MedRock%20Florida&category=Commercial%20Rx&from=close
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const m = q.get('month');
    const loc = q.get('location');
    const cat = q.get('category');
    const st = q.get('status');
    const s = q.get('search');
    if (m) setMonth(m);
    if (loc) setLocation(loc);
    if (cat) setCategory(cat);
    if (st) setStatus(st);
    if (s) {
      setSearch(s);
      setDebouncedSearch(s);
    }
    if (q.get('from') === 'close') setFromClose(true);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 350);
    return () => window.clearTimeout(t);
  }, [search]);

  // The whole ledger history in one call — the month picker then re-cuts what is
  // already here rather than refetching per step.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/inventory/as-of')
      .then((r) => r.json() as Promise<AsOfResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('error' in data) setSummaryError(data.error);
        else {
          setAsOf(data);
          setMonth((prev) => prev ?? data.latestMonth);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setSummaryError(e instanceof Error ? e.message : 'Failed to load valuation');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/inventory/rollback')
      .then((r) => r.json() as Promise<RollbackResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('rows' in data) setRollbackRows(data.rows);
      })
      .catch(() => {
        // Non-fatal: the reconstruction is a cross-check, not the figure itself.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Summary supplies the selector lists, the anchored-month badges, and the CASH
  // figures (the lot ledger has no basis dimension). Never the accrual numbers.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/inventory/summary?basis=${basis}&location=all`)
      .then((r) => r.json() as Promise<SummaryResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('error' in data) setSummaryError(data.error);
        else {
          setSummary(data);
          setSummaryError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setSummaryError(e instanceof Error ? e.message : 'Failed to load summary');
      });
    return () => {
      cancelled = true;
    };
  }, [basis]);

  const selectedMonth = month ?? asOf?.latestMonth ?? null;

  // Keep the address bar in step so any view here is linkable and refreshable.
  // replaceState, not pushState: Back must return to whatever sent us here
  // (often the close tab), not walk backwards through filter changes.
  useEffect(() => {
    if (!selectedMonth) return;
    const q = new URLSearchParams();
    q.set('month', selectedMonth);
    if (location !== 'all') q.set('location', location);
    if (category !== 'all') q.set('category', category);
    if (status !== 'all') q.set('status', status);
    if (debouncedSearch) q.set('search', debouncedSearch);
    if (fromClose) q.set('from', 'close');
    window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
  }, [selectedMonth, location, category, status, debouncedSearch, fromClose]);

  /**
   * ONE SOURCE FOR EVERY FIGURE ON THIS PAGE — read this before repointing anything.
   *
   * Accrual cells come from /api/inventory/as-of, which reads the same module the
   * month-end close builds its category lines from (lib/inventory/ledger-values).
   * Not a second query that ought to agree — the same one. `fifo_valuation_summary`
   * is NOT interchangeable: it ties on the total but not per category, and it
   * holds an accrual and a cash row per cell. See ledger-values.ts.
   *
   * Cash is the one exception, labelled as such on screen: no basis dimension in
   * the ledger, so it falls back to the summary table, does not tie to the close,
   * and carries no lot counts.
   */
  const allCells = useMemo<Cell[]>(() => {
    if (basis === 'accrual') {
      return (asOf?.rows ?? []).map((r) => ({
        month: r.month,
        location: r.location,
        qbCategory: r.qbCategory,
        value: r.value,
        lotCount: r.lotCount,
      }));
    }
    return (summary?.rows ?? []).map((r) => ({
      month: r.as_of_month,
      location: r.location,
      qbCategory: r.qb_category,
      value: r.on_hand_value_fifo,
      lotCount: null,
    }));
  }, [basis, asOf, summary]);

  /** True when every figure on screen is the one the close posts from. */
  const drillable = basis === 'accrual';

  const scopedCells = useMemo(
    () => allCells.filter((c) => (location === 'all' || c.location === location)),
    [allCells, location],
  );

  const monthCells = useMemo(
    () => scopedCells.filter((c) => c.month === selectedMonth),
    [scopedCells, selectedMonth],
  );

  const view = useMemo(() => {
    // Round at the CELL, then aggregate in integer cents. Rounding once at the
    // end instead lets two groupings of the same cells land a cent apart, and
    // the by-location table then fails to foot to the headline above it. One
    // cell is one (location, category), which is also one line of the close, so
    // its rounding matches the close's line for line.
    const locCents = new Map<string, number>();
    const catCents = new Map<string, number>();
    const lotsByCategory = new Map<string, number>();
    let totalCents = 0;
    for (const c of monthCells) {
      const cents = Math.round(c.value * 100);
      totalCents += cents;
      locCents.set(c.location, (locCents.get(c.location) ?? 0) + cents);
      catCents.set(c.qbCategory, (catCents.get(c.qbCategory) ?? 0) + cents);
      if (c.lotCount !== null) {
        lotsByCategory.set(c.qbCategory, (lotsByCategory.get(c.qbCategory) ?? 0) + c.lotCount);
      }
    }
    const toDollars = (m: Map<string, number>): Map<string, number> =>
      new Map([...m].map(([k, cents]) => [k, cents / 100]));
    return {
      total: totalCents / 100,
      byLocation: toDollars(locCents),
      byCategory: toDollars(catCents),
      lotsByCategory,
    };
  }, [monthCells]);

  const months = asOf?.months ?? [];
  const allCategories = useMemo(
    () => [...new Set(allCells.map((c) => c.qbCategory))].sort(),
    [allCells],
  );

  /** The reconstruction totalled per month for the current location scope —
   *  receipt-priced, the settled methodology (2026-08-26). */
  const rollbackByMonth = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rollbackRows) {
      if (location !== 'all' && r.location !== location) continue;
      m.set(r.as_of_month, (m.get(r.as_of_month) ?? 0) + (r.value_floor ?? 0));
    }
    return m;
  }, [rollbackRows, location]);

  const chartData = useMemo(() => {
    const byMonth = new Map<string, Record<string, number | string>>();
    for (const c of scopedCells) {
      const entry = byMonth.get(c.month) ?? { month: c.month, Total: 0 };
      entry[c.qbCategory] = ((entry[c.qbCategory] as number | undefined) ?? 0) + c.value;
      entry.Total = (entry.Total as number) + c.value;
      byMonth.set(c.month, entry);
    }
    // The three location lines, ALWAYS company-wide (from the unfiltered cells)
    // so the comparison view survives a location filter — Total still follows
    // the filter, the location lines are the constant reference.
    for (const c of allCells) {
      const entry = byMonth.get(c.month) ?? { month: c.month, Total: 0 };
      const key = shortInventoryLocation(c.location);
      entry[key] = ((entry[key] as number | undefined) ?? 0) + c.value;
      byMonth.set(c.month, entry);
    }
    // The reconstruction rides alongside the simulated total so the divergence is
    // the visible story. Without it the series reads as four years of growth
    // followed by an inexplicable collapse; with it, it reads as what it is —
    // one line drifting away from the other and then being pulled back.
    // Accrual only: the reconstruction has no cash basis.
    if (basis === 'accrual') {
      for (const [m, value] of rollbackByMonth) {
        const entry = byMonth.get(m);
        if (entry) entry.Reconstruction = value;
      }
    }
    return [...byMonth.values()].sort((a, b) => String(a.month).localeCompare(String(b.month)));
  }, [scopedCells, allCells, rollbackByMonth, basis]);

  /** Default-visible series; a legend click flips a key away from its default.
   *  Location lines follow the page's location filter: filtering to Florida
   *  auto-hides TN and TX (no clicks needed); 'all' shows all three. */
  const DEFAULT_VISIBLE = useMemo(() => {
    const base = new Set(['Total', 'Reconstruction']);
    if (location === 'all') {
      base.add('FL');
      base.add('TN');
      base.add('TX');
    } else {
      base.add(shortInventoryLocation(location));
    }
    return base;
  }, [location]);
  const seriesVisible = useCallback(
    (key: string): boolean => DEFAULT_VISIBLE.has(key) !== toggledSeries.has(key),
    [DEFAULT_VISIBLE, toggledSeries],
  );
  const toggleSeries = useCallback((key: string) => {
    setToggledSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // A location change re-derives the location lines' defaults; stale manual
  // toggles on FL/TN/TX would invert the new defaults, so drop just those.
  useEffect(() => {
    setToggledSeries((prev) => {
      const next = new Set([...prev].filter((k) => k !== 'FL' && k !== 'TN' && k !== 'TX'));
      return next.size === prev.size ? prev : next;
    });
  }, [location]);

  const LOCATION_LINE_COLORS: Record<string, string> = useMemo(
    () => ({ FL: '#0284c7', TN: '#ea580c', TX: '#db2777' }),
    [],
  );

  /**
   * The windowed view: months whose month-end falls within 90 days of the
   * selected month's. Monthly grain, so that is the selected month and the two
   * before it — focused on now, with the y-axis rescaled to the recent level
   * instead of the historical peak. 'all' shows the full history.
   */
  const windowedChartData = useMemo(() => {
    if (chartRange === 'all' || !selectedMonth || chartData.length === 0) return chartData;
    const end = new Date(`${selectedMonth}-01T00:00:00Z`);
    const start = new Date(end.getTime() - 90 * 86_400_000);
    const floor = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    return chartData.filter((d) => String(d.month) >= floor && String(d.month) <= selectedMonth);
  }, [chartRange, chartData, selectedMonth]);

  /**
   * The pre-anchor history accumulates unrecorded shrink for years, and all of
   * it discharges at the FIRST anchored month-end — the first date with a real
   * count to write down against. By design that month sits BEFORE the postable
   * window, so the step never lands in a journal entry. Detected rather than
   * hardcoded, so the banner disappears if the shape ever does.
   */
  const anchorDrop = useMemo(() => {
    const anchoredMonths = summary?.anchoredMonths ?? [];
    if (anchoredMonths.length === 0 || chartData.length < 2) return null;
    const first = anchoredMonths[0];
    const i = chartData.findIndex((d) => d.month === first);
    if (i < 1) return null;
    const before = chartData[i - 1].Total as number;
    const after = chartData[i].Total as number;
    if (before <= 0 || after >= before * 0.75) return null;
    return { month: first, before, after };
  }, [summary, chartData]);

  // The backward reconstruction, kept as a CROSS-CHECK only. It has no category
  // or lot dimension, so nothing on it can be traced to a receipt — but it is
  // built backward from LifeFile's lot report, so a wide gap is the honest signal
  // that a month's forward simulation is running high.
  const rollbackTotal = useMemo(() => {
    const rows = selectedMonth
      ? rollbackRows.filter(
          (r) => r.as_of_month === selectedMonth && (location === 'all' || r.location === location),
        )
      : [];
    return { has: rows.length > 0, value: rows.reduce((s, r) => s + (r.value_floor ?? 0), 0) };
  }, [rollbackRows, selectedMonth, location]);

  const anchored = !!(summary && selectedMonth && summary.anchoredMonths.includes(selectedMonth));
  const dates = selectedMonth ? monthDates(selectedMonth) : null;

  // Purchases made before a location's reliable-usage floor (Florida's
  // Pioneer-era compounding, mainly) are held OUT of the valuation as an
  // auditable bucket rather than silently deleted. The dollars are real money
  // spent, so the page must say where they went — this sums the excluded value
  // for the selected month and scope.
  const preFloorExcluded = useMemo(() => {
    if (!summary || !selectedMonth) return 0;
    return summary.rows
      .filter(
        (r) =>
          r.as_of_month === selectedMonth &&
          (location === 'all' || r.location === location),
      )
      .reduce((s, r) => s + (r.pre_floor_collapsed_value ?? 0), 0);
  }, [summary, selectedMonth, location]);

  /**
   * The selected month's movement, from the SAME summary rows the close's
   * monthly statement is built from — purchases in, usage-driven COGS out,
   * waste and shrink to the dedicated 5000.55 line. COGS is consumption minus
   * the waste+shrink the columns carry (they sum to the JE line by
   * construction). Null when the month predates the adjustment-feed columns.
   */
  const monthMovement = useMemo(() => {
    if (basis !== 'accrual' || !summary || !selectedMonth) return null;
    const rows = summary.rows.filter(
      (r) => r.as_of_month === selectedMonth && (location === 'all' || r.location === location),
    );
    if (rows.length === 0) return null;
    if (!rows.some((r) => r.waste_value_in_month !== null || r.shrink_value_in_month !== null)) return null;
    const sum = (f: (r: (typeof rows)[number]) => number): number =>
      rows.reduce((s, r) => s + Math.round(f(r) * 100), 0) / 100;
    const purchases = sum((r) => r.receipts_value_in_month);
    const consumed = sum((r) => r.consumed_value_in_month);
    const waste = sum((r) => r.waste_value_in_month ?? 0);
    const shrink = sum((r) => r.shrink_value_in_month ?? 0);
    return { purchases, cogs: consumed - waste - shrink, waste, shrink };
  }, [basis, summary, selectedMonth, location]);

  const lotsQuery = useMemo(() => {
    const params = new URLSearchParams({
      location,
      category,
      status,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (selectedMonth) params.set('month', selectedMonth);
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (sortKey) {
      params.set('sort', sortKey);
      params.set('dir', sortDir);
    }
    return params.toString();
  }, [location, category, status, selectedMonth, debouncedSearch, page, sortKey, sortDir]);

  const handleSort = useCallback(
    (column: LotColumn) => {
      setPage(0);
      if (sortKey === column.key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(column.key);
        setSortDir(column.defaultDesc ? 'desc' : 'asc');
      }
    },
    [sortKey],
  );

  useEffect(() => {
    // Don't fetch a page of lots for "no month yet" — that would answer for the
    // latest month and then be replaced, flashing the wrong figures.
    if (!selectedMonth) return;
    let cancelled = false;
    setLotsLoading(true);
    fetch(`/api/inventory/lots?${lotsQuery}`)
      .then((r) => r.json() as Promise<LotsResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('error' in data) setLotsError(data.error);
        else {
          setLots(data);
          setLotsError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setLotsError(e instanceof Error ? e.message : 'Failed to load lots');
      })
      .finally(() => {
        if (!cancelled) setLotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lotsQuery, selectedMonth]);

  // An open product's receipts are as-of a month; changing the month (or the
  // scope that produced the row) must close it rather than leave last month's
  // FIFO queue open under this month's numbers.
  useEffect(() => {
    setExpandedKey(null);
    setDetail(null);
  }, [selectedMonth, location, category, status, debouncedSearch]);

  const toggleExpand = useCallback(
    (row: ProductGroupRow) => {
      const key = row.product_key;
      if (expandedKey === key) {
        setExpandedKey(null);
        setDetail(null);
        return;
      }
      setExpandedKey(key);
      setDetail(null);
      setDetailLoading(true);
      const params = new URLSearchParams({ key, location });
      if (selectedMonth) params.set('month', selectedMonth);
      fetch(`/api/inventory/product?${params.toString()}`)
        .then((r) => r.json() as Promise<ProductDetailResponse | { error: string }>)
        .then((data) => {
          if (!('error' in data)) setDetail(data);
        })
        .finally(() => setDetailLoading(false));
    },
    [expandedKey, location, selectedMonth],
  );

  const exportHref = useCallback(
    (kind: 'summary' | 'lots', format: 'csv' | 'xlsx'): string => {
      if (kind === 'summary') {
        return `/api/inventory/summary?basis=${basis}&location=${encodeURIComponent(location)}&format=${format}`;
      }
      const params = new URLSearchParams({ location, category, status, format });
      if (selectedMonth) params.set('month', selectedMonth);
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (sortKey) {
        params.set('sort', sortKey);
        params.set('dir', sortDir);
      }
      return `/api/inventory/lots?${params.toString()}`;
    },
    [basis, location, category, status, selectedMonth, debouncedSearch, sortKey, sortDir],
  );

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const tableHead = darkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600';
  const rowBorder = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;
  const navBtnCls = 'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg border-2 shadow-sm transition-opacity hover:opacity-80';
  const navBtnStyle = { borderColor: BRAND_PURPLE, color: darkMode ? '#c4b0e6' : BRAND_PURPLE };
  const exportBtnCls = 'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg text-white shadow-sm transition-opacity hover:opacity-85';
  const exportBtnStyle = { backgroundColor: BRAND_PURPLE };

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-screen-2xl mx-auto space-y-6">
        {fromClose && selectedMonth && (
          <a
            href={`/payroll?tab=inventoryclose&month=${encodeURIComponent(selectedMonth)}`}
            className={`inline-flex items-center gap-1.5 text-sm font-medium underline ${
              darkMode ? 'text-blue-300' : 'text-blue-600'
            }`}
          >
            ← Back to the {selectedMonth} inventory close
          </a>
        )}

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              Inventory Valuation (FIFO)
            </h1>
            <p className={`text-sm ${subText}`}>
              Lot-level purchases depleted first-in-first-out, valued at actual purchase price, as of any month-end.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <HelpTip
              label="Accrual vs. cash basis"
              text="Accrual counts a purchase when the goods were received. Cash re-times it to the date QuickBooks shows the bill was paid — it un-grays once receipts are linked to QB payments on the QB Links page. The month-end close posts on the accrual basis, so only accrual ties to it."
            />
            <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
              <button
                onClick={() => setBasis('accrual')}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  basis === 'accrual' ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
                }`}
                style={basis === 'accrual' ? { backgroundColor: BRAND_PURPLE } : undefined}
              >
                Accrual
              </button>
              <button
                disabled={!summary?.hasCashBasis}
                onClick={() => setBasis('cash')}
                title={
                  summary?.hasCashBasis
                    ? 'Receipts re-timed to QuickBooks payment dates — does not tie to the close, and has no receipt-level detail'
                    : 'Un-grays once QB purchase links are synced and the loader ships cash-basis rows — see QB Links'
                }
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  summary?.hasCashBasis
                    ? basis === 'cash'
                      ? 'text-white'
                      : darkMode
                        ? 'text-slate-300'
                        : 'text-slate-600'
                    : `cursor-not-allowed ${darkMode ? 'text-slate-600' : 'text-slate-400'}`
                }`}
                style={basis === 'cash' && summary?.hasCashBasis ? { backgroundColor: BRAND_PURPLE } : undefined}
              >
                Cash
              </button>
            </div>
            <a href="/inventory/qb-links" className={navBtnCls} style={navBtnStyle}>
              QB Links
            </a>
          </div>
        </div>

        {/* Sub-tabs: valuation vs. the shared Methodology & evidence view. */}
        <div className={`inline-flex rounded-xl border p-1 ${cardBg} ${rowBorder}`}>
          <button
            onClick={() => setPageTab('valuation')}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
              pageTab === 'valuation' ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
            }`}
            style={pageTab === 'valuation' ? { backgroundColor: BRAND_PURPLE } : undefined}
          >
            Valuation
          </button>
          <button
            onClick={() => setPageTab('method')}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
              pageTab === 'method' ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
            }`}
            style={pageTab === 'method' ? { backgroundColor: BRAND_PURPLE } : undefined}
          >
            Methodology &amp; evidence
          </button>
        </div>

        {pageTab === 'method' ? (
          <InventoryMethodology darkMode={darkMode} />
        ) : (
        <>
        <Explainer id="inventory-valuation" title="What am I looking at?">
          <p>
            Every purchase entered into LifeFile becomes a <strong>lot</strong> — a batch of stock with the date,
            quantity, and actual price we paid. As product is dispensed or used in compounding, the oldest lots are
            drawn down first (FIFO). What remains, valued at what each lot actually cost, is the inventory value on
            this page.
          </p>
          <p>
            <strong>The month picker drives everything below it.</strong> Total, locations, categories, the trend
            line, the product table and the purchase receipts inside it all restate as of the month-end you choose.
            Click a location or a category to narrow the detail; click a product for the individual receipts behind
            it.
          </p>
          <p>
            <strong>Every accrual figure here is the one the month-end journal entry posts from</strong>, so an entry
            can be traced from the posted amount down to the document. The close itself lives on the{' '}
            <strong>Journal Entries page</strong> under <strong>Inventory Close</strong>.
          </p>
          <p>
            <strong>Recent months are anchored to real counts.</strong> Every month-end in the anchor window (late
            2025 forward) is pinned to LifeFile&rsquo;s Balance-On-Hand count for that date: recorded usage and the
            documented disposal log deplete the lots first, and any remaining gap against the count is written down
            in that month as shrink — write-down only, never written up. The current month is additionally checked
            lot-by-lot against the live lot report. Months <em>before</em> the anchor window are simulation-only
            history: they exist to walk the lots forward to a defensible opening and never receive journal entries.
            The <strong>reconstruction cross-check</strong> below the breakdowns is a second, independent valuation
            built backward from the lot report — the two methods agreeing is the page&rsquo;s standing control.
          </p>
          <p>
            <strong>Badges you will see:</strong> <span className="font-semibold">OB</span> = includes an opening
            balance (stock that predates our receipt history, estimated from a LifeFile snapshot).{' '}
            <span className="font-semibold">Shortfall</span> = usage exceeded known purchases at some point, a sign of
            missing receipts or duplicate product records. <span className="font-semibold">LF</span> = that lot&rsquo;s
            remaining quantity is pinned to LifeFile&rsquo;s report rather than simulated.
          </p>
          <p>
            <strong>One standing exclusion:</strong> purchases from Florida&rsquo;s pre-conversion compounding era
            (the Pioneer system, before LifeFile{preFloorExcluded > 0 ? ` — ${usd.format(preFloorExcluded)} for the current scope` : ''}) are
            held out of every figure here as a flagged, auditable bucket. Pioneer&rsquo;s own fill records
            corroborate that stock was consumed in its era; nothing is deleted, no entry posts from it, and the
            exclusion is reversible if better period records ever surface.
          </p>
          <p>
            Every figure is receipt-priced and reproducible: purchases at actual invoice cost, usage and disposal
            from the pharmacy system&rsquo;s own records, endings tied to dated counts. The full method — with
            definitions and data sources — lives on the Journal Entries page under{' '}
            <strong>Inventory Close → Methodology &amp; evidence</strong>.
          </p>
        </Explainer>

        {summaryError && (
          <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">
            {summaryError}
          </div>
        )}

        {/* The month picker — the control this whole page hangs off */}
        <div className={`rounded-xl shadow-sm p-4 flex flex-wrap items-center gap-3 ${cardBg}`}>
          <label className="text-sm font-semibold">As of end of</label>
          {/* Newest first — recent months are what anyone comes here for. The API
              ships `months` oldest-first, so reversing is display-only. */}
          <select
            value={selectedMonth ?? ''}
            onChange={(e) => {
              setMonth(e.target.value);
              setPage(0);
            }}
            className={inputCls}
          >
            {[...months].reverse().map((m) => (
              <option key={m} value={m}>
                {m} (close {monthDates(m).asOf})
              </option>
            ))}
          </select>
          <select
            value={location}
            onChange={(e) => {
              setLocation(e.target.value);
              setPage(0);
            }}
            className={inputCls}
          >
            <option value="all">All locations</option>
            {(summary?.locations ?? []).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <span className={`text-xs ${subText}`}>
            {months.length > 0
              ? `${months.length} months available (${months[0]} – ${months[months.length - 1]})`
              : ''}
          </span>
        </div>

        {/* Headline */}
        {dates && (
          <div className={`rounded-2xl shadow-sm p-6 md:p-8 ${cardBg}`}>
            <p className={`text-sm ${subText}`}>
              On <strong>{dates.openingLong}</strong> (close of business {dates.asOf}),{' '}
              {location === 'all'
                ? 'total inventory value is'
                : `${shortInventoryLocation(location)} inventory value is`}
            </p>
            <p className="text-4xl md:text-5xl font-bold mt-2">{usd.format(view.total)}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {drillable ? (
                <span
                  title="This is the figure the inventory-close journal entry posts from, summed from the same lot ledger — every dollar traces to a purchase receipt"
                  className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold cursor-help"
                >
                  ✓ Ties to the month-end journal entry
                </span>
              ) : (
                <span
                  title="Cash basis re-times purchases to their QuickBooks payment date. The close posts on the accrual basis, so this figure does not tie to it and has no receipt-level drill-down."
                  className="text-xs px-2 py-1 rounded border bg-amber-50 text-amber-800 border-amber-200 font-semibold cursor-help"
                >
                  ⚠ Cash basis — does not tie to the close
                </span>
              )}
              {anchored ? (
                <span
                  title="This month-end is anchored to LifeFile's dated Balance-On-Hand count (the current month additionally lot-by-lot against the live lot report) — its ending carries its own measured waste and shrink"
                  className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold cursor-help"
                >
                  ✓ Anchored to a dated count
                </span>
              ) : (
                <span
                  title="This month predates the anchor window: no count exists to write it down against, so it carries accumulated unrecorded shrink and runs high. Simulation-only history — no journal entry ever posts from it."
                  className="text-xs px-2 py-1 rounded border bg-amber-50 text-amber-800 border-amber-200 font-semibold cursor-help"
                >
                  ⚠ Pre-anchor history — never posted
                </span>
              )}
              <span className={`text-xs ${subText}`}>{basis === 'accrual' ? 'Accrual basis' : 'Cash basis'}</span>
            </div>
            <p className={`text-xs mt-3 ${subText}`}>
              Stock on hand at month end, valued at what each lot actually cost — with an estimated cost only where the
              purchase receipt is missing.
            </p>
          </div>
        )}

        {/* The month's movement — the same figures the close's monthly statement
            posts, cut to the current scope. */}
        {monthMovement && anchored && (
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <p className="text-sm font-semibold flex items-center gap-1.5">
              This month&rsquo;s movement
              <HelpTip
                label="Where these figures go"
                text="Purchases at actual invoice cost flow in; usage-driven COGS posts to each category's COGS account; waste (the documented disposal log) and shrink (the count residual) post together to the dedicated 5000.55 Drug Waste & Shrinkage line. These are the same numbers the month's close JE is built from — the Inventory Close tab shows the identical statement."
              />
            </p>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className={`text-xs ${subText}`}>Purchases</p>
                <p className="text-xl font-bold tabular-nums">{usd.format(monthMovement.purchases)}</p>
              </div>
              <div>
                <p className={`text-xs ${subText}`}>COGS (usage)</p>
                <p className="text-xl font-bold tabular-nums">{usd.format(monthMovement.cogs)}</p>
              </div>
              <div>
                <p className={`text-xs ${subText}`}>Waste (documented)</p>
                <p className="text-xl font-bold tabular-nums">{usd.format(monthMovement.waste)}</p>
              </div>
              <div>
                <p className={`text-xs ${subText}`}>Shrink (count residual)</p>
                <p className="text-xl font-bold tabular-nums">{usd.format(monthMovement.shrink)}</p>
              </div>
            </div>
            <p className={`text-xs mt-3 ${subText}`}>
              Beginning + Purchases − COGS − Waste − Shrink = the ending value above, to the cent. Waste and
              shrink post to <strong>5000.55 Drug Waste &amp; Shrinkage</strong>, never commingled with
              operating COGS.
            </p>
          </div>
        )}

        {/* Breakdowns — clicking a row narrows the detail below, so these are the
            navigation as well as the summary. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <p className="text-sm font-semibold">By location</p>
              {location !== 'all' && (
                <button
                  onClick={() => {
                    setLocation('all');
                    setPage(0);
                  }}
                  className={`text-xs underline ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}
                >
                  Clear
                </button>
              )}
            </div>
            <BreakdownTable
              rows={[...view.byLocation.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([key, value]) => ({ key, label: shortInventoryLocation(key), value, lots: null }))}
              total={view.total}
              selected={location === 'all' ? null : location}
              onSelect={(key) => {
                setLocation((prev) => (prev === key ? 'all' : key));
                setPage(0);
              }}
              rowBorder={rowBorder}
              subText={subText}
              darkMode={darkMode}
            />
          </div>

          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <p className="text-sm font-semibold">By QuickBooks category</p>
              {category !== 'all' && (
                <button
                  onClick={() => {
                    setCategory('all');
                    setPage(0);
                  }}
                  className={`text-xs underline ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}
                >
                  Clear
                </button>
              )}
            </div>
            <BreakdownTable
              rows={[...view.byCategory.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([key, value]) => ({
                  key,
                  label: key,
                  value,
                  lots: view.lotsByCategory.get(key) ?? null,
                  color: categoryColor(key),
                }))}
              total={view.total}
              selected={category === 'all' ? null : category}
              onSelect={(key) => {
                setCategory((prev) => (prev === key ? 'all' : key));
                setPage(0);
              }}
              rowBorder={rowBorder}
              subText={subText}
              darkMode={darkMode}
            />
          </div>
        </div>

        {/* Reconstruction cross-check */}
        {drillable && rollbackTotal.has && (
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <p className="text-sm font-semibold">Reconstruction cross-check</p>
            <p className={`text-xs mt-1 ${subText}`}>
              An independent estimate built backward from LifeFile&rsquo;s lot report, for the same month and scope.
              It has no category or lot detail, so it cannot be traced to receipts and is not what the journal entry
              posts.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-6">
              <div>
                <p className={`text-xs ${subText}`}>Reconstruction</p>
                <p className="text-xl font-bold tabular-nums">{usd.format(rollbackTotal.value)}</p>
              </div>
              <div>
                <p className={`text-xs ${subText}`}>Variance vs. the figure above</p>
                <p className="text-xl font-bold tabular-nums" style={{ color: '#2563eb' }}>
                  {usd.format(rollbackTotal.value - view.total)}
                </p>
              </div>
            </div>
            {Math.abs(rollbackTotal.value - view.total) > 0.25 * Math.max(Math.abs(view.total), 1) && (
              <p
                className={`text-xs mt-3 px-2 py-1.5 rounded border ${
                  darkMode
                    ? 'bg-amber-950/30 border-amber-800 text-amber-200'
                    : 'bg-amber-50 border-amber-300 text-amber-800'
                }`}
              >
                These are far apart — which means the selected month predates the anchor window. Pre-anchor months
                carry accumulated unrecorded shrink (no count exists to write them down against) and run high. They
                are simulation-only history: no journal entry ever posts from them. Anchored months agree with this
                cross-check within the posting gate.
              </p>
            )}
          </div>
        )}

        {/* Trend */}
        {chartData.length > 1 && (
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <p className="text-sm font-semibold flex items-center gap-1.5">
                On-Hand Value by Month
                {location === 'all' ? '' : ` — ${shortInventoryLocation(location)}`}
                <HelpTip
                  label="How to read this chart"
                  text="Month-end on-hand value by category, for the current location scope. The default view is the last 90 days ending at the selected month; All time shows the full history, including the pre-anchor era and its one-time discharge step. The red dashed line is the reconstruction — an independent valuation built backward from LifeFile's lot report — shown so the two methods can be compared directly. Click a series chip to hide or show its line; the axis rescales to what is visible."
                />
              </p>
            </div>

            {/* ONE control row: the window toggle and the line toggles together. */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
                <button
                  onClick={() => setChartRange('90d')}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    chartRange === '90d' ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
                  }`}
                  style={chartRange === '90d' ? { backgroundColor: BRAND_PURPLE } : undefined}
                >
                  Last 90 days
                </button>
                <button
                  onClick={() => setChartRange('all')}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    chartRange === 'all' ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
                  }`}
                  style={chartRange === 'all' ? { backgroundColor: BRAND_PURPLE } : undefined}
                >
                  All time
                </button>
              </div>
            </div>

            {/* The shape of this chart is a data problem, not a design one, and
                the explanation belongs next to it — the climb-then-collapse is
                the first thing anyone asks about. Only on the all-time view:
                the 90-day window never shows the discharge step. */}
            {chartRange === 'all' && anchorDrop && (
              <div
                className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
                  darkMode
                    ? 'bg-amber-950/30 border-amber-800 text-amber-200'
                    : 'bg-amber-50 border-amber-300 text-amber-800'
                }`}
              >
                <span className="font-semibold">
                  The climb and the {Math.round((1 - anchorDrop.after / anchorDrop.before) * 100)}% step at{' '}
                  {anchorDrop.month} are the pre-anchor history correcting itself — inventory did not grow for years
                  and then vanish in a month.
                </span>{' '}
                Months before {anchorDrop.month} have no count to write down against, so years of unrecorded shrink
                accumulate in the line; {anchorDrop.month} is the first month-end with a real count, and the whole
                accumulation discharges there in one step — deliberately <em>before</em> the postable window, so no
                journal entry ever carries it. From {anchorDrop.month} forward every month is anchored to its own
                count and carries only its own measured waste and shrink; the green and red lines run together from
                there, which is the two methods agreeing.
              </div>
            )}
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={windowedChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#334155' : '#e2e8f0'} />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke={darkMode ? '#94a3b8' : '#64748b'} />
                  <YAxis
                    tickFormatter={(v: number) => usd0.format(v)}
                    tick={{ fontSize: 12 }}
                    stroke={darkMode ? '#94a3b8' : '#64748b'}
                    width={90}
                  />
                  <Tooltip formatter={(v: number | undefined) => usd.format(v ?? 0)} />
                  {selectedMonth && (
                    <ReferenceLine x={selectedMonth} stroke="#2563eb" strokeDasharray="4 4" />
                  )}
                  {seriesVisible('Total') && (
                    <Line type="monotone" dataKey="Total" stroke="#16a34a" strokeWidth={2} dot={false} />
                  )}
                  {/* connectNulls: the reconstruction only covers the months the
                      rollback table holds, and a straight line drawn across the
                      gap would invent values it does not have. */}
                  {seriesVisible('Reconstruction') && (
                    <Line
                      type="monotone"
                      dataKey="Reconstruction"
                      stroke="#dc2626"
                      strokeWidth={2}
                      strokeDasharray="5 3"
                      dot={false}
                      connectNulls={false}
                    />
                  )}
                  {(['FL', 'TN', 'TX'] as const)
                    .filter((loc) => seriesVisible(loc))
                    .map((loc) => (
                      <Line
                        key={loc}
                        type="monotone"
                        dataKey={loc}
                        stroke={LOCATION_LINE_COLORS[loc]}
                        strokeWidth={1.5}
                        dot={false}
                      />
                    ))}
                  {allCategories
                    .filter((cat) => seriesVisible(cat))
                    .map((cat) => (
                      <Line key={cat} type="monotone" dataKey={cat} stroke={categoryColor(cat)} dot={false} />
                    ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* The legend IS the control: click an entry to show/hide its line.
                Dimmed entries are off — categories start off so the default
                view stays the Total / locations / reconstruction comparison. */}
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
              {[
                { key: 'Total', color: '#16a34a', desc: 'On-hand value for the current filter scope' },
                { key: 'Reconstruction', color: '#dc2626', desc: 'Independent backward cross-check (dashed)' },
                { key: 'FL', color: LOCATION_LINE_COLORS.FL, desc: 'Florida — company-wide, ignores the location filter' },
                { key: 'TN', color: LOCATION_LINE_COLORS.TN, desc: 'Tennessee — company-wide, ignores the location filter' },
                { key: 'TX', color: LOCATION_LINE_COLORS.TX, desc: 'Texas — company-wide, ignores the location filter' },
                ...allCategories.map((c) => ({
                  key: c,
                  color: categoryColor(c),
                  desc:
                    c === 'Uncoded'
                      ? 'Purchases awaiting drug coding'
                      : c === 'Opening Balance'
                        ? 'Stock predating our receipt history'
                        : `${c} category cut of the scoped total`,
                })),
              ].map(({ key, color, desc }) => {
                const visible = seriesVisible(key);
                return (
                  <button
                    key={key}
                    onClick={() => toggleSeries(key)}
                    title={visible ? `Hide ${key}` : `Show ${key}`}
                    className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-opacity ${rowBorder} ${
                      visible ? '' : 'opacity-40'
                    } ${darkMode ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'}`}
                  >
                    <span className="w-2 h-2 mt-1 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden />
                    <span className="min-w-0">
                      <span className={`block text-xs font-semibold ${visible ? '' : 'line-through'}`}>{key}</span>
                      <span className={`block text-[11px] leading-tight ${subText}`}>{desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Filters + product table */}
        <div className={`rounded-xl shadow-sm ${cardBg}`}>
          <div className="p-4 flex flex-wrap items-center gap-3 border-b border-inherit">
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Search product, NDC, or lot #"
              className={`${inputCls} w-64`}
            />
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setPage(0);
              }}
              className={inputCls}
            >
              <option value="all">All Categories</option>
              {allCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
              className={inputCls}
            >
              <option value="all">All Lots</option>
              <option value="open">Open (qty remaining)</option>
              <option value="fully_used">Fully Used</option>
            </select>
            <span className={`text-xs ${subText}`}>
              as of {selectedMonth ?? '—'}
              {location === 'all' ? '' : ` · ${shortInventoryLocation(location)}`}
            </span>
            <div className="ml-auto flex gap-2">
              <a href={exportHref('lots', 'csv')} className={exportBtnCls} style={exportBtnStyle}>
                <DownloadIcon /> Export CSV
              </a>
              <a href={exportHref('lots', 'xlsx')} className={exportBtnCls} style={exportBtnStyle}>
                <DownloadIcon /> Export Excel
              </a>
              <a
                href={exportHref('summary', 'xlsx')}
                title="Every month's summary rows, not just the selected month"
                className={`${exportBtnCls} opacity-80`}
                style={exportBtnStyle}
              >
                <DownloadIcon /> All months
              </a>
            </div>
          </div>

          {lotsError && <div className="p-4 text-sm text-red-600">{lotsError}</div>}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={tableHead}>
                  {LOT_COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={`px-3 py-2 font-medium ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                    >
                      <span className={`inline-flex items-center gap-1.5 ${col.align === 'right' ? 'flex-row-reverse' : ''}`}>
                        <button
                          onClick={() => handleSort(col)}
                          className={`inline-flex items-center gap-1 hover:underline ${
                            col.align === 'right' ? 'flex-row-reverse' : ''
                          }`}
                          title={`Sort by ${col.label}`}
                        >
                          {col.label}
                          <span className="text-[10px] w-3 inline-block">
                            {sortKey === col.key ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                          </span>
                        </button>
                        {col.help && <HelpTip label={col.label} text={col.help} />}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lotsLoading && (
                  <tr>
                    <td colSpan={9} className={`px-3 py-8 text-center ${subText}`}>
                      Loading…
                    </td>
                  </tr>
                )}
                {!lotsLoading && (lots?.rows.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={9} className={`px-3 py-8 text-center ${subText}`}>
                      No products match the current filters.
                    </td>
                  </tr>
                )}
                {!lotsLoading &&
                  lots?.rows.map((row) => (
                    <ProductTableRow
                      key={row.product_key}
                      row={row}
                      expanded={expandedKey === row.product_key}
                      onToggle={() => toggleExpand(row)}
                      detail={expandedKey === row.product_key ? detail : null}
                      detailLoading={expandedKey === row.product_key && detailLoading}
                      darkMode={darkMode}
                      rowBorder={rowBorder}
                      subText={subText}
                    />
                  ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className={`p-4 flex items-center justify-between text-sm ${subText}`}>
            <span>
              {lots ? `${lots.total.toLocaleString()} products · page ${page + 1} of ${Math.max(1, Math.ceil(lots.total / PAGE_SIZE))}` : ''}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className={`px-3 py-1.5 rounded-lg border ${rowBorder} disabled:opacity-40`}
              >
                Previous
              </button>
              <button
                disabled={!lots || (page + 1) * PAGE_SIZE >= lots.total}
                onClick={() => setPage((p) => p + 1)}
                className={`px-3 py-1.5 rounded-lg border ${rowBorder} disabled:opacity-40`}
              >
                Next
              </button>
            </div>
          </div>
        </div>

        <p className={`text-sm ${subText}`}>
          Looking for the roll-forward &amp; suggested journal entry? The monthly close lives on the{' '}
          <a
            href={`/payroll?tab=inventoryclose${selectedMonth ? `&month=${encodeURIComponent(selectedMonth)}` : ''}`}
            className="underline font-medium"
          >
            Journal Entries page → Inventory Close
          </a>
          .
        </p>
        </>
        )}
      </div>
    </div>
  );
}

interface BreakdownRow {
  key: string;
  label: string;
  value: number;
  lots: number | null;
  color?: string;
}

/** A breakdown that is also a filter: clicking a row scopes the detail below,
 *  clicking the selected row again clears it. */
function BreakdownTable({
  rows,
  total,
  selected,
  onSelect,
  rowBorder,
  subText,
  darkMode,
}: {
  rows: BreakdownRow[];
  total: number;
  selected: string | null;
  onSelect: (key: string) => void;
  rowBorder: string;
  subText: string;
  darkMode: boolean;
}) {
  if (rows.length === 0) return <p className={`text-sm ${subText}`}>No data for this month.</p>;
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map((r) => {
          const isSelected = selected === r.key;
          return (
            <tr
              key={r.key}
              onClick={() => onSelect(r.key)}
              title={isSelected ? 'Click again to clear this filter' : `Show only ${r.label}`}
              className={`border-t cursor-pointer ${rowBorder} ${
                isSelected
                  ? darkMode
                    ? 'bg-slate-700/60'
                    : 'bg-blue-50'
                  : darkMode
                    ? 'hover:bg-slate-700/40'
                    : 'hover:bg-slate-50'
              }`}
            >
              <td className="py-2">
                <span className="flex items-center gap-2">
                  {r.color && (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: r.color }}
                      aria-hidden
                    />
                  )}
                  <span className={isSelected ? 'font-semibold' : ''}>{r.label}</span>
                </span>
              </td>
              <td className={`py-2 text-right tabular-nums ${subText} w-20`}>
                {r.lots === null ? '' : `${r.lots.toLocaleString()} lots`}
              </td>
              <td className="py-2 text-right tabular-nums font-medium">{usd.format(r.value)}</td>
              <td className={`py-2 text-right tabular-nums ${subText} w-16`}>
                {total > 0 ? `${Math.round((r.value / total) * 100)}%` : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface ProductTableRowProps {
  row: ProductGroupRow;
  expanded: boolean;
  onToggle: () => void;
  detail: ProductDetailResponse | null;
  detailLoading: boolean;
  darkMode: boolean;
  rowBorder: string;
  subText: string;
}

function ProductTableRow({ row, expanded, onToggle, detail, detailLoading, darkMode, rowBorder, subText }: ProductTableRowProps) {
  const productNumber = row.ndc || (row.product_key.startsWith('name:') ? null : row.product_key);
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-t ${rowBorder} cursor-pointer transition-colors ${
          darkMode ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'
        }`}
      >
        <td className="px-3 py-2">
          <div className="font-medium flex items-center gap-2">
            {row.product_name ?? row.product_key}
            {row.has_opening_balance && (
              <span
                title="Includes an opening balance — stock that predates our receipt history, estimated from a LifeFile snapshot"
                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-500 uppercase cursor-help"
              >
                OB
              </span>
            )}
            {row.had_shortfall && (
              <span
                title="Usage exceeded known purchases at some point — a sign of missing receipts or duplicate product records"
                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 uppercase cursor-help"
              >
                Shortfall
              </span>
            )}
          </div>
          {productNumber && <div className={`text-xs ${subText}`}>{productNumber}</div>}
        </td>
        <td className="px-3 py-2">{row.qb_category}</td>
        <td className="px-3 py-2">{row.locations}</td>
        <td className="px-3 py-2 text-right">
          {row.lot_count}
          {row.open_lots > 0 && <span className={`text-xs ${subText}`}> ({row.open_lots} open)</span>}
        </td>
        <td className="px-3 py-2">{row.last_received ?? '—'}</td>
        <td className="px-3 py-2 text-right">{qty.format(row.qty_consumed)}</td>
        <td className="px-3 py-2 text-right">{qty.format(row.qty_remaining)}</td>
        <td className="px-3 py-2 text-right font-medium">
          {row.remaining_value !== null ? usd.format(row.remaining_value) : '—'}
        </td>
        <td className="px-3 py-2">
          {row.open_lots === 0 ? (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 font-medium">
              fully used
            </span>
          ) : (
            <span className={`text-xs ${subText}`}>open</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className={`border-t ${rowBorder}`}>
          <td colSpan={9} className={`px-6 py-4 ${darkMode ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
            {detailLoading && <p className={`text-sm ${subText}`}>Loading FIFO history…</p>}
            {detail && <FifoQueue detail={detail} rowBorder={rowBorder} subText={subText} />}
          </td>
        </tr>
      )}
    </>
  );
}
