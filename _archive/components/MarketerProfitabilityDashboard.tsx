'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import { QuickBooksStatusIndicator } from './QuickBooksStatusIndicator';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

type Granularity = 'monthly' | 'quarterly' | 'yearly';

interface Stats {
  totalTransactions: number;
  totalNetProfit: number;
  totalRevenue: number;
  totalAcquisitionCost: number;
  uniqueMarketers: number;
}

interface MarketerData {
  period: string;
  marketer_name: string;
  patient_state?: string;
  transaction_count: number;
  acquisition_cost: number;
  shipping_charged_to_pt: number;
  shipping_cost_actual: number;
  total_pt_paid: number;
  profit_after_product: number;
  net_profit: number;
}

interface PeriodGroup {
  period: string;
  marketers: MarketerData[];
  totals: {
    transaction_count: number;
    acquisition_cost: number;
    shipping_charged_to_pt: number;
    shipping_cost_actual: number;
    total_pt_paid: number;
    profit_after_product: number;
    net_profit: number;
  };
}

interface ChartDataPoint {
  period: string;
  transaction_count: number;
  net_profit: number;
  total_pt_paid: number;
}

interface QuickBooksData {
  connected: boolean;
  location?: string;
  message?: string;
  error?: string;
  data?: Array<{
    period: string;
    revenue: number;
    product_revenue: number;
    shipping_revenue: number;
    cost_of_goods: number;
    gross_profit: number;
  }>;
  totals?: {
    revenue: number;
    product_revenue: number;
    shipping_revenue: number;
    cost_of_goods: number;
    gross_profit: number;
  };
}

interface QuickBooksComparison {
  period: string;
  internal_revenue: number;
  quickbooks_revenue: number;
  quickbooks_product_revenue: number;
  quickbooks_shipping_revenue: number;
  quickbooks_cogs: number;
  quickbooks_gross_profit: number;
  variance: number;
  variance_percentage: number;
}

interface ApiResponse {
  stats: Stats;
  dateRange: { minYear: number; maxYear: number };
  marketers: string[];
  locations: string[];
  periodGroups: PeriodGroup[];
  stateBreakdown: Record<string, MarketerData[]>;
  chartData: ChartDataPoint[];
  granularity: Granularity;
  quickbooks?: QuickBooksData;
  quickbooksComparison?: QuickBooksComparison[];
  qbCacheInfo?: { cached: boolean; ageSeconds?: number };
}

interface Filters {
  location: string;
  marketer: string;
  startDate: string;
  endDate: string;
}

export default function MarketerProfitabilityDashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<Granularity>('monthly');
  const { darkMode } = useDarkMode();
  const [filters, setFilters] = useState<Filters>({
    location: 'all',
    marketer: '',
    startDate: '',
    endDate: '',
  });
  const [appliedFilters, setAppliedFilters] = useState<Filters>(filters);
  const [expandedPeriods, setExpandedPeriods] = useState<Set<string>>(new Set());
  const [expandedMarketers, setExpandedMarketers] = useState<Set<string>>(new Set());
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
  const [showQuickBooksComparison, setShowQuickBooksComparison] = useState(false);
  const [qbAccountingMethod, setQbAccountingMethod] = useState<'Cash' | 'Accrual'>('Cash');
  const [showMergedView, setShowMergedView] = useState(false);
  const [qbLoading, setQbLoading] = useState(false);

  // Helper to convert period string to date range
  const periodToDateRange = useCallback((period: string, granularity: Granularity): { start: string; end: string } => {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD format

    if (granularity === 'yearly') {
      const endDate = `${period}-12-31`;
      return {
        start: `${period}-01-01`,
        end: endDate > todayStr ? todayStr : endDate, // Cap at today if future
      };
    } else if (granularity === 'quarterly') {
      // Format: YYYY-Q1, YYYY-Q2, etc.
      const [year, quarter] = period.split('-Q');
      const q = parseInt(quarter);
      const startMonth = (q - 1) * 3 + 1;
      const endMonth = startMonth + 2;
      const endDate = `${year}-${endMonth.toString().padStart(2, '0')}-${new Date(parseInt(year), endMonth, 0).getDate()}`;
      return {
        start: `${year}-${startMonth.toString().padStart(2, '0')}-01`,
        end: endDate > todayStr ? todayStr : endDate, // Cap at today if future
      };
    } else {
      // Monthly: YYYY-MM
      const [year, month] = period.split('-');
      const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
      const endDate = `${year}-${month}-${lastDay.toString().padStart(2, '0')}`;
      return {
        start: `${year}-${month}-01`,
        end: endDate > todayStr ? todayStr : endDate, // Cap at today if future
      };
    }
  }, []);

  const fetchData = useCallback(async (currentFilters: Filters, currentGranularity: Granularity, includeQB: boolean, accountingMethod: 'Cash' | 'Accrual', autoDetectedDates?: { start: string; end: string }) => {
    setLoading(true);
    if (includeQB) {
      setQbLoading(true);
    }
    try {
      const params = new URLSearchParams();
      if (currentFilters.location !== 'all') params.set('location', currentFilters.location);
      if (currentFilters.marketer) params.set('marketer', currentFilters.marketer);
      if (currentFilters.startDate) params.set('startDate', currentFilters.startDate);
      if (currentFilters.endDate) params.set('endDate', currentFilters.endDate);
      params.set('granularity', currentGranularity);

      // Include QuickBooks comparison if toggle is on
      // Use explicit date filters if provided, otherwise use auto-detected dates
      if (includeQB) {
        params.set('includeQuickBooks', 'true');
        params.set('accountingMethod', accountingMethod);
        if (autoDetectedDates && !currentFilters.startDate && !currentFilters.endDate) {
          params.set('startDate', autoDetectedDates.start);
          params.set('endDate', autoDetectedDates.end);
        }
      }

      const url = `/api/marketer-profitability${params.toString() ? `?${params.toString()}` : ''}`;
      const res = await fetch(url);
      const result = await res.json();

      if (result.error) {
        setError(result.error);
      } else {
        setData(result);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
      setQbLoading(false);
    }
  }, []);

  useEffect(() => {
    // Auto-detect date range from visible data when QB toggle is on and no manual dates set
    let autoDetectedDates: { start: string; end: string } | undefined;
    if (showQuickBooksComparison && data?.periodGroups && data.periodGroups.length > 0 && !appliedFilters.startDate && !appliedFilters.endDate) {
      const periods = data.periodGroups.map(g => g.period).sort();
      const firstPeriod = periods[0];
      const lastPeriod = periods[periods.length - 1];

      const firstRange = periodToDateRange(firstPeriod, granularity);
      const lastRange = periodToDateRange(lastPeriod, granularity);

      autoDetectedDates = {
        start: firstRange.start,
        end: lastRange.end,
      };
    }

    fetchData(appliedFilters, granularity, showQuickBooksComparison, qbAccountingMethod, autoDetectedDates);
    // Note: data.periodGroups is accessed but not a dependency to avoid infinite loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedFilters, granularity, showQuickBooksComparison, qbAccountingMethod]);

  const handleApplyFilters = () => {
    setAppliedFilters({ ...filters });
  };

  const handleResetFilters = () => {
    const defaultFilters: Filters = { location: 'all', marketer: '', startDate: '', endDate: '' };
    setFilters(defaultFilters);
    setAppliedFilters(defaultFilters);
  };

  const handleGranularityChange = (newGranularity: Granularity) => {
    setGranularity(newGranularity);
  };

  const togglePeriod = (period: string) => {
    const newExpanded = new Set(expandedPeriods);
    if (newExpanded.has(period)) {
      newExpanded.delete(period);
    } else {
      newExpanded.add(period);
    }
    setExpandedPeriods(newExpanded);
  };

  const toggleMarketer = (key: string) => {
    const newExpanded = new Set(expandedMarketers);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedMarketers(newExpanded);
  };

  const formatCurrency = (value: number | null | undefined) => {
    if (value === null || value === undefined || isNaN(value)) return '$0.00';
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatNumber = (value: number | null | undefined) => {
    if (value === null || value === undefined || isNaN(value)) return '0';
    return value.toLocaleString();
  };

  const downloadCSV = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const exportSummary = () => {
    if (!data) return;
    setExportDropdownOpen(false);

    const lines = [
      'MARKETER PROFITABILITY SUMMARY',
      `Generated: ${new Date().toLocaleString()}`,
      `Granularity: ${granularity}`,
      showQuickBooksComparison ? `QB Accounting Method: ${qbAccountingMethod}` : '',
      '',
      'OVERVIEW',
      `Total Transactions,${data.stats.totalTransactions}`,
      `Total Revenue,$${data.stats.totalRevenue.toFixed(2)}`,
      `Total Net Profit,$${data.stats.totalNetProfit.toFixed(2)}`,
      `Unique Marketers,${data.stats.uniqueMarketers}`,
      '',
      'BY PERIOD AND MARKETER',
    ].filter(line => line !== '');

    // Add header row with optional QB columns
    const headerRow = ['Period', 'Marketer', 'Transactions', 'Product Cost', 'Ship Cost', 'Ship Chg', 'LifeFile Reported'];
    if (showQuickBooksComparison && data.quickbooksComparison) {
      headerRow.push('QB Product Rev', 'QB Ship Rev', 'QB Total Rev', 'QB COGS', 'QB Gross Profit', 'Variance $', 'Variance %');
    }
    headerRow.push('Gross Profit', 'Net Profit');
    lines.push(headerRow.join(','));

    // Track totals for QB comparison
    let totals = {
      transactions: 0,
      product_cost: 0,
      ship_cost: 0,
      ship_chg: 0,
      lifefile_revenue: 0,
      qb_product_revenue: 0,
      qb_shipping_revenue: 0,
      qb_total_revenue: 0,
      qb_cogs: 0,
      qb_gross_profit: 0,
      variance: 0,
      gross_profit: 0,
      net_profit: 0,
    };

    data.periodGroups.forEach(group => {
      const qbData = showQuickBooksComparison ? getQBDataForPeriod(group.period) : null;

      group.marketers.forEach(m => {
        const row = [
          m.period,
          `"${m.marketer_name}"`,
          m.transaction_count,
          m.acquisition_cost.toFixed(2),
          m.shipping_charged_to_pt.toFixed(2),
          m.shipping_cost_actual.toFixed(2),
          m.total_pt_paid.toFixed(2),
        ];

        // Accumulate totals
        totals.transactions += m.transaction_count;
        totals.product_cost += m.acquisition_cost;
        totals.ship_cost += m.shipping_charged_to_pt;
        totals.ship_chg += m.shipping_cost_actual;
        totals.lifefile_revenue += m.total_pt_paid;
        totals.gross_profit += m.profit_after_product;
        totals.net_profit += m.net_profit;

        if (showQuickBooksComparison && data.quickbooksComparison) {
          if (qbData) {
            row.push(
              qbData.quickbooks_product_revenue.toFixed(2),
              qbData.quickbooks_shipping_revenue.toFixed(2),
              qbData.quickbooks_revenue.toFixed(2),
              qbData.quickbooks_cogs.toFixed(2),
              qbData.quickbooks_gross_profit.toFixed(2),
              qbData.variance.toFixed(2),
              qbData.variance_percentage.toFixed(2)
            );
          } else {
            row.push('N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A');
          }
        }

        row.push(m.profit_after_product.toFixed(2), m.net_profit.toFixed(2));
        lines.push(row.join(','));
      });

      // Accumulate QB totals at period level
      if (showQuickBooksComparison && qbData) {
        totals.qb_product_revenue += qbData.quickbooks_product_revenue || 0;
        totals.qb_shipping_revenue += qbData.quickbooks_shipping_revenue || 0;
        totals.qb_total_revenue += qbData.quickbooks_revenue || 0;
        totals.qb_cogs += qbData.quickbooks_cogs || 0;
        totals.qb_gross_profit += qbData.quickbooks_gross_profit || 0;
        totals.variance += qbData.variance || 0;
      }
    });

    // Add totals row
    lines.push('');
    const totalsRow = [
      'TOTAL',
      '',
      totals.transactions,
      totals.product_cost.toFixed(2),
      totals.ship_cost.toFixed(2),
      totals.ship_chg.toFixed(2),
      totals.lifefile_revenue.toFixed(2),
    ];

    if (showQuickBooksComparison && data.quickbooksComparison) {
      const totalVariancePercentage = totals.qb_total_revenue !== 0
        ? ((totals.variance / totals.qb_total_revenue) * 100)
        : 0;
      totalsRow.push(
        totals.qb_product_revenue.toFixed(2),
        totals.qb_shipping_revenue.toFixed(2),
        totals.qb_total_revenue.toFixed(2),
        totals.qb_cogs.toFixed(2),
        totals.qb_gross_profit.toFixed(2),
        totals.variance.toFixed(2),
        totalVariancePercentage.toFixed(2)
      );
    }

    totalsRow.push(totals.gross_profit.toFixed(2), totals.net_profit.toFixed(2));
    lines.push(totalsRow.join(','));

    const csv = lines.join('\n');
    const dateStr = new Date().toISOString().split('T')[0];
    downloadCSV(csv, `marketer-profitability-${dateStr}.csv`);
  };

  const exportDetailed = () => {
    if (!data) return;
    setExportDropdownOpen(false);

    const lines = [
      'MARKETER PROFITABILITY WITH STATE BREAKDOWN',
      `Generated: ${new Date().toLocaleString()}`,
      `Granularity: ${granularity}`,
      showQuickBooksComparison ? `QB Accounting Method: ${qbAccountingMethod}` : '',
      '',
    ].filter(line => line !== '');

    // Add header row with optional QB columns
    const headerRow = ['Period', 'Marketer', 'State', 'Transactions', 'Product Cost', 'Ship Cost', 'Ship Chg', 'LifeFile Reported'];
    if (showQuickBooksComparison && data.quickbooksComparison) {
      headerRow.push('QB Product Rev (Period)', 'QB Ship Rev (Period)', 'QB Total Rev (Period)', 'QB COGS (Period)', 'QB Gross Profit (Period)', 'Variance $ (Period)', 'Variance % (Period)');
    }
    headerRow.push('Gross Profit', 'Net Profit');
    lines.push(headerRow.join(','));

    // Track totals
    let totals = {
      transactions: 0,
      product_cost: 0,
      ship_cost: 0,
      ship_chg: 0,
      lifefile_revenue: 0,
      qb_product_revenue: 0,
      qb_shipping_revenue: 0,
      qb_total_revenue: 0,
      qb_cogs: 0,
      qb_gross_profit: 0,
      variance: 0,
      gross_profit: 0,
      net_profit: 0,
    };

    // Track which periods we've already added QB data for (to avoid duplication)
    const processedPeriods = new Set<string>();

    Object.entries(data.stateBreakdown).forEach(([, states]) => {
      states.forEach(s => {
        const qbData = showQuickBooksComparison ? getQBDataForPeriod(s.period) : null;

        const row = [
          s.period,
          `"${s.marketer_name}"`,
          s.patient_state || '',
          s.transaction_count,
          s.acquisition_cost.toFixed(2),
          s.shipping_charged_to_pt.toFixed(2),
          s.shipping_cost_actual.toFixed(2),
          s.total_pt_paid.toFixed(2),
        ];

        // Accumulate totals
        totals.transactions += s.transaction_count;
        totals.product_cost += s.acquisition_cost;
        totals.ship_cost += s.shipping_charged_to_pt;
        totals.ship_chg += s.shipping_cost_actual;
        totals.lifefile_revenue += s.total_pt_paid;
        totals.gross_profit += s.profit_after_product;
        totals.net_profit += s.net_profit;

        if (showQuickBooksComparison && data.quickbooksComparison) {
          if (qbData) {
            row.push(
              qbData.quickbooks_product_revenue.toFixed(2),
              qbData.quickbooks_shipping_revenue.toFixed(2),
              qbData.quickbooks_revenue.toFixed(2),
              qbData.quickbooks_cogs.toFixed(2),
              qbData.quickbooks_gross_profit.toFixed(2),
              qbData.variance.toFixed(2),
              qbData.variance_percentage.toFixed(2)
            );
            // Only add QB totals once per period
            if (!processedPeriods.has(s.period)) {
              totals.qb_product_revenue += qbData.quickbooks_product_revenue || 0;
              totals.qb_shipping_revenue += qbData.quickbooks_shipping_revenue || 0;
              totals.qb_total_revenue += qbData.quickbooks_revenue || 0;
              totals.qb_cogs += qbData.quickbooks_cogs || 0;
              totals.qb_gross_profit += qbData.quickbooks_gross_profit || 0;
              totals.variance += qbData.variance || 0;
              processedPeriods.add(s.period);
            }
          } else {
            row.push('N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A');
          }
        }

        row.push(s.profit_after_product.toFixed(2), s.net_profit.toFixed(2));
        lines.push(row.join(','));
      });
    });

    // Add totals row
    lines.push('');
    const totalsRow = [
      'TOTAL',
      '',
      '',
      totals.transactions,
      totals.product_cost.toFixed(2),
      totals.ship_cost.toFixed(2),
      totals.ship_chg.toFixed(2),
      totals.lifefile_revenue.toFixed(2),
    ];

    if (showQuickBooksComparison && data.quickbooksComparison) {
      const totalVariancePercentage = totals.qb_total_revenue !== 0
        ? ((totals.variance / totals.qb_total_revenue) * 100)
        : 0;
      totalsRow.push(
        totals.qb_product_revenue.toFixed(2),
        totals.qb_shipping_revenue.toFixed(2),
        totals.qb_total_revenue.toFixed(2),
        totals.qb_cogs.toFixed(2),
        totals.qb_gross_profit.toFixed(2),
        totals.variance.toFixed(2),
        totalVariancePercentage.toFixed(2)
      );
    }

    totalsRow.push(totals.gross_profit.toFixed(2), totals.net_profit.toFixed(2));
    lines.push(totalsRow.join(','));

    const csv = lines.join('\n');
    const dateStr = new Date().toISOString().split('T')[0];
    downloadCSV(csv, `marketer-profitability-detailed-${dateStr}.csv`);
  };

  const formatPeriodLabel = (period: string) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (granularity === 'yearly') return period;
    if (granularity === 'quarterly') return period;
    // Monthly: YYYY-MM
    const [year, month] = period.split('-');
    return `${months[parseInt(month) - 1]} ${year}`;
  };

  // Get QB data for a specific period
  const getQBDataForPeriod = (period: string) => {
    if (!data?.quickbooksComparison) return null;
    return data.quickbooksComparison.find(qb => qb.period === period);
  };

  const hasActiveFilters = appliedFilters.location !== 'all' || appliedFilters.marketer || appliedFilters.startDate || appliedFilters.endDate;

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl">Loading marketer profitability data...</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl text-red-600">Error: {error}</div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className={`min-h-screen p-8 transition-colors ${darkMode ? 'bg-gray-900' : 'bg-gray-50'}`}>
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-6">
          <div>
            <h1 className={`text-3xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>AMY</h1>
            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Accounting Metrics & Yields</p>
          </div>
          <div className="relative">
            <button
              onClick={() => setExportDropdownOpen(!exportDropdownOpen)}
              className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors flex items-center gap-2"
            >
              Export
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {exportDropdownOpen && (
              <div className={`absolute right-0 mt-2 w-48 rounded-lg shadow-lg border py-1 z-10 ${
                darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
              }`}>
                <button
                  onClick={exportSummary}
                  className={`w-full text-left px-4 py-2 text-sm ${
                    darkMode ? 'text-gray-200 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  CSV - Summary
                </button>
                <button
                  onClick={exportDetailed}
                  className={`w-full text-left px-4 py-2 text-sm ${
                    darkMode ? 'text-gray-200 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  CSV - With State Breakdown
                </button>
              </div>
            )}
          </div>
        </div>

        <h2 className={`text-2xl font-semibold mb-4 ${darkMode ? 'text-gray-100' : 'text-gray-800'}`}>
          Marketer Profitability
        </h2>

        {/* QuickBooks Status Indicator (only when specific location selected) */}
        {appliedFilters.location !== 'all' && (
          <div className="mb-6">
            <QuickBooksStatusIndicator location={appliedFilters.location} />
          </div>
        )}

        {/* Filters */}
        <div className={`rounded-lg shadow p-6 mb-8 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Filters</h3>
            {hasActiveFilters && (
              <span className="text-sm text-blue-500 font-medium">Filters applied</span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                Start Date
              </label>
              <input
                type="date"
                value={filters.startDate}
                onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                  darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                }`}
              />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                End Date
              </label>
              <input
                type="date"
                value={filters.endDate}
                onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                  darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                }`}
              />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                Location
              </label>
              <select
                value={filters.location}
                onChange={(e) => {
                  const newLocation = e.target.value;
                  setFilters({ ...filters, location: newLocation });
                }}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 ${
                  darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                }`}
              >
                <option value="all">All Locations</option>
                {data.locations.map(loc => (
                  <option key={loc} value={loc}>{loc}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                Marketer
              </label>
              <select
                value={filters.marketer}
                onChange={(e) => setFilters({ ...filters, marketer: e.target.value })}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 ${
                  darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                }`}
              >
                <option value="">All Marketers</option>
                {data.marketers.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-2">
              <button
                onClick={handleApplyFilters}
                disabled={loading}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Loading...' : 'Apply'}
              </button>
              <button
                onClick={handleResetFilters}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  darkMode ? 'bg-gray-700 text-gray-200 hover:bg-gray-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className={`rounded-lg shadow p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className={`text-sm font-medium ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Total Transactions</div>
            <div className={`text-3xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {formatNumber(data.stats.totalTransactions)}
            </div>
          </div>
          <div className={`rounded-lg shadow p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className={`text-sm font-medium ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Total Revenue</div>
            <div className="text-3xl font-bold text-blue-500">{formatCurrency(data.stats.totalRevenue)}</div>
          </div>
          <div className={`rounded-lg shadow p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className={`text-sm font-medium ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Net Profit</div>
            <div className="text-3xl font-bold text-green-500">{formatCurrency(data.stats.totalNetProfit)}</div>
          </div>
          <div className={`rounded-lg shadow p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className={`text-sm font-medium ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Unique Marketers</div>
            <div className={`text-3xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {data.stats.uniqueMarketers}
            </div>
          </div>
        </div>

        {/* Chart */}
        <div className={`rounded-lg shadow p-6 mb-8 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="flex justify-between items-center mb-4">
            <h3 className={`text-xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {granularity.charAt(0).toUpperCase() + granularity.slice(1)} Trends
            </h3>
            {/* Granularity selector */}
            <div className={`flex gap-1 rounded-lg p-1 ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
              {(['monthly', 'quarterly', 'yearly'] as Granularity[]).map((g) => (
                <button
                  key={g}
                  onClick={() => handleGranularityChange(g)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    granularity === g
                      ? darkMode ? 'bg-gray-600 text-white shadow-sm' : 'bg-white text-gray-900 shadow-sm'
                      : darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {g.charAt(0).toUpperCase() + g.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="h-80" style={{ minHeight: '320px' }}>
            {data.chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%" minHeight={320} key={`chart-${granularity}-${data.chartData.length}`}>
                <LineChart data={data.chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#374151' : '#e5e7eb'} />
                  <XAxis
                    dataKey="period"
                    tick={{ fontSize: 11, fill: darkMode ? '#9ca3af' : '#374151' }}
                    tickFormatter={(p) => formatPeriodLabel(p)}
                    stroke={darkMode ? '#4b5563' : '#d1d5db'}
                    angle={-45}
                    textAnchor="end"
                    height={60}
                    interval={Math.max(0, Math.floor(data.chartData.length / 15) - 1)}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: darkMode ? '#9ca3af' : '#374151' }}
                    tickFormatter={(v) => `$${(v / 1000).toLocaleString()}k`}
                    stroke={darkMode ? '#4b5563' : '#d1d5db'}
                    width={80}
                  />
                  <Tooltip
                    formatter={(value) => formatCurrency(Number(value) || 0)}
                    labelFormatter={(label) => formatPeriodLabel(String(label))}
                    contentStyle={{
                      backgroundColor: darkMode ? '#1f2937' : '#ffffff',
                      border: `1px solid ${darkMode ? '#374151' : '#e5e7eb'}`,
                      borderRadius: '8px',
                      color: darkMode ? '#f3f4f6' : '#111827',
                    }}
                  />
                  <Legend wrapperStyle={{ color: darkMode ? '#9ca3af' : '#374151' }} />
                  <Line
                    type="monotone"
                    dataKey="net_profit"
                    stroke="#10B981"
                    strokeWidth={2}
                    dot={{ fill: '#10B981', strokeWidth: 2, r: 4 }}
                    name="Net Profit"
                  />
                  <Line
                    type="monotone"
                    dataKey="total_pt_paid"
                    stroke="#3B82F6"
                    strokeWidth={2}
                    dot={{ fill: '#3B82F6', strokeWidth: 2, r: 4 }}
                    name="Total Revenue"
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className={`flex items-center justify-center h-full ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                No data available for the selected filters
              </div>
            )}
          </div>
        </div>

        {/* QuickBooks Toggles - Below Chart */}
        <div className={`rounded-lg shadow p-4 mb-8 ${darkMode ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200'}`}>
          <div className="space-y-4">
            {/* QuickBooks Comparison Toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                <div className="flex-1">
                  <h3 className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    QuickBooks Comparison
                  </h3>
                  <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {data?.periodGroups && data.periodGroups.length > 0
                      ? 'Compare LifeFile reported revenue with QuickBooks data (date range auto-detected)'
                      : 'No data available to compare'}
                  </p>
                  {/* Show QB loading indicator */}
                  {qbLoading && (
                    <div className="mt-2 flex items-start gap-2 text-xs text-blue-600">
                      <svg className="w-4 h-4 mt-0.5 flex-shrink-0 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span>Loading QuickBooks data... This may take a moment for multiple periods.</span>
                    </div>
                  )}
                  {/* Show QB error if present */}
                  {!qbLoading && showQuickBooksComparison && data?.quickbooks?.error && (
                    <div className="mt-2 flex items-start gap-2 text-xs text-amber-600">
                      <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span>{data.quickbooks.error}</span>
                    </div>
                  )}
                  {/* Show cache status */}
                  {!qbLoading && showQuickBooksComparison && data?.qbCacheInfo && (
                    <div className="mt-2 inline-flex items-center gap-1.5 text-xs">
                      {data.qbCacheInfo.cached ? (
                        <>
                          <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          <span className={`${darkMode ? 'text-emerald-400' : 'text-emerald-600'}`}>
                            Cached ({data.qbCacheInfo.ageSeconds}s ago)
                          </span>
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          <span className={`${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                            Fresh from QB API
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <label className={`flex items-center gap-3 ${data?.periodGroups && data.periodGroups.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                <span className={`text-sm font-medium ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  {showQuickBooksComparison ? 'On' : 'Off'}
                </span>
                <div className="relative">
                  <input
                    type="checkbox"
                    checked={showQuickBooksComparison}
                    onChange={(e) => setShowQuickBooksComparison(e.target.checked)}
                    disabled={!data?.periodGroups || data.periodGroups.length === 0}
                    className="sr-only peer"
                  />
                  <div className={`w-14 h-7 rounded-full peer transition-colors ${
                    showQuickBooksComparison ? 'bg-blue-600' : darkMode ? 'bg-gray-700' : 'bg-gray-300'
                  }`}></div>
                  <div className={`absolute left-1 top-1 w-5 h-5 bg-white rounded-full transition-transform shadow-md ${
                    showQuickBooksComparison ? 'translate-x-7' : ''
                  }`}></div>
                </div>
              </label>
            </div>

            {/* Accounting Method Toggle - Only show when QB comparison is enabled */}
            {showQuickBooksComparison && (
              <div className={`flex items-center justify-between pt-4 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                <div className="flex items-center gap-3">
                  <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <div className="flex-1">
                    <h3 className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      Accounting Method
                    </h3>
                    <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                      Cash = revenue when received | Accrual = revenue when earned
                    </p>
                  </div>
                </div>
                <label className="flex items-center gap-3 cursor-pointer">
                  <span className={`text-sm font-medium ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    {qbAccountingMethod}
                  </span>
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={qbAccountingMethod === 'Accrual'}
                      onChange={(e) => setQbAccountingMethod(e.target.checked ? 'Accrual' : 'Cash')}
                      className="sr-only peer"
                    />
                    <div className={`w-14 h-7 rounded-full peer transition-colors ${
                      qbAccountingMethod === 'Accrual' ? 'bg-green-600' : darkMode ? 'bg-gray-700' : 'bg-gray-300'
                    }`}></div>
                    <div className={`absolute left-1 top-1 w-5 h-5 bg-white rounded-full transition-transform shadow-md ${
                      qbAccountingMethod === 'Accrual' ? 'translate-x-7' : ''
                    }`}></div>
                  </div>
                </label>
              </div>
            )}

            {/* Merged View Toggle - Only show when QB comparison is enabled */}
            {showQuickBooksComparison && (
              <div className={`flex items-center justify-between pt-4 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                <div className="flex items-center gap-3">
                  <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                  </svg>
                  <div className="flex-1">
                    <h3 className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      Merged Table View
                    </h3>
                    <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                      Show LifeFile and QuickBooks data in a single merged table with variance columns
                    </p>
                  </div>
                </div>
                <label className="flex items-center gap-3 cursor-pointer">
                  <span className={`text-sm font-medium ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    {showMergedView ? 'Merged' : 'Separate'}
                  </span>
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={showMergedView}
                      onChange={(e) => setShowMergedView(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className={`w-14 h-7 rounded-full peer transition-colors ${
                      showMergedView ? 'bg-purple-600' : darkMode ? 'bg-gray-700' : 'bg-gray-300'
                    }`}></div>
                    <div className={`absolute left-1 top-1 w-5 h-5 bg-white rounded-full transition-transform shadow-md ${
                      showMergedView ? 'translate-x-7' : ''
                    }`}></div>
                  </div>
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Data Table */}
        <div className={`rounded-lg shadow ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="p-6 border-b border-gray-700">
            <h3 className={`text-xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Marketer Breakdown by {granularity.charAt(0).toUpperCase() + granularity.slice(1)}
            </h3>
          </div>
          <div className="overflow-x-auto">
            {data.periodGroups.length > 0 ? (
              <table className="w-full text-sm">
                <thead className={`sticky top-0 ${darkMode ? 'bg-gray-700' : 'bg-gray-50'}`}>
                  <tr>
                    <th className={`text-left py-3 px-4 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Period / Marketer</th>
                    <th className={`text-right py-3 px-4 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Transactions</th>
                    <th className={`text-right py-3 px-4 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Product Cost</th>
                    <th className={`text-right py-3 px-4 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Ship Cost</th>
                    <th className={`text-right py-3 px-4 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Ship Chg</th>
                    <th className={`text-right py-3 px-4 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>LifeFile Reported</th>
                    {showQuickBooksComparison && showMergedView && (
                      <>
                        <th className={`text-right py-3 px-4 font-medium text-blue-500 border-l-2 ${darkMode ? 'border-blue-800' : 'border-blue-200'}`}>QB Revenue</th>
                        <th className={`text-right py-3 px-4 font-medium text-blue-500`}>Variance</th>
                        <th className={`text-right py-3 px-4 font-medium text-blue-500`}>Variance %</th>
                      </>
                    )}
                    <th className={`text-right py-3 px-4 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Gross Profit</th>
                    <th className={`text-right py-3 px-4 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Net Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.periodGroups.map((group) => {
                    const isPeriodExpanded = expandedPeriods.has(group.period);
                    return (
                      <React.Fragment key={group.period}>
                        {/* Period Header Row */}
                        <tr
                          className={`cursor-pointer ${darkMode ? 'bg-gray-750 hover:bg-gray-700' : 'bg-gray-100 hover:bg-gray-200'}`}
                          onClick={() => togglePeriod(group.period)}
                        >
                          <td className={`py-3 px-4 font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            <span className="mr-2">{isPeriodExpanded ? '▼' : '▶'}</span>
                            {formatPeriodLabel(group.period)}
                          </td>
                          <td className={`py-3 px-4 text-right font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            {formatNumber(group.totals.transaction_count)}
                          </td>
                          <td className={`py-3 px-4 text-right font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            {formatCurrency(group.totals.acquisition_cost)}
                          </td>
                          <td className={`py-3 px-4 text-right font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            {formatCurrency(group.totals.shipping_charged_to_pt)}
                          </td>
                          <td className={`py-3 px-4 text-right font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            {formatCurrency(group.totals.shipping_cost_actual)}
                          </td>
                          <td className={`py-3 px-4 text-right font-semibold text-blue-500`}>
                            {formatCurrency(group.totals.total_pt_paid)}
                          </td>
                          {showQuickBooksComparison && showMergedView && (() => {
                            const qbData = getQBDataForPeriod(group.period);
                            if (qbData) {
                              const isPositiveVariance = qbData.variance >= 0;
                              const varianceColor = isPositiveVariance ? 'text-green-500' : 'text-red-500';
                              return (
                                <>
                                  <td className={`py-3 px-4 text-right font-semibold border-l-2 ${darkMode ? 'border-blue-800 text-blue-400' : 'border-blue-200 text-blue-600'}`}>
                                    {formatCurrency(qbData.quickbooks_revenue)}
                                  </td>
                                  <td className={`py-3 px-4 text-right font-semibold ${varianceColor}`}>
                                    {isPositiveVariance ? '+' : ''}{formatCurrency(qbData.variance)}
                                  </td>
                                  <td className={`py-3 px-4 text-right font-semibold ${varianceColor}`}>
                                    {isPositiveVariance ? '+' : ''}{(qbData.variance_percentage ?? 0).toFixed(2)}%
                                  </td>
                                </>
                              );
                            }
                            return (
                              <>
                                <td className={`py-3 px-4 text-right text-gray-500 border-l-2 ${darkMode ? 'border-blue-800' : 'border-blue-200'}`}>—</td>
                                <td className={`py-3 px-4 text-right text-gray-500`}>—</td>
                                <td className={`py-3 px-4 text-right text-gray-500`}>—</td>
                              </>
                            );
                          })()}
                          <td className={`py-3 px-4 text-right font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            {formatCurrency(group.totals.profit_after_product)}
                          </td>
                          <td className="py-3 px-4 text-right font-semibold text-green-500">
                            {formatCurrency(group.totals.net_profit)}
                          </td>
                        </tr>

                        {/* Marketer Rows (expanded) */}
                        {isPeriodExpanded && group.marketers.map((marketer, idx) => {
                          const marketerKey = `${group.period}|${marketer.marketer_name}`;
                          const isMarketerExpanded = expandedMarketers.has(marketerKey);
                          const stateData = data.stateBreakdown[marketerKey] || [];

                          return (
                            <React.Fragment key={marketerKey}>
                              <tr
                                className={`cursor-pointer ${
                                  darkMode
                                    ? (idx % 2 === 0 ? 'bg-gray-800' : 'bg-gray-850')
                                    : (idx % 2 === 0 ? 'bg-white' : 'bg-gray-50')
                                } ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                                onClick={() => toggleMarketer(marketerKey)}
                              >
                                <td className={`py-2 px-4 pl-8 ${darkMode ? 'text-gray-200' : 'text-gray-900'}`}>
                                  <span className="mr-2 text-xs">{isMarketerExpanded ? '▼' : '▶'}</span>
                                  {marketer.marketer_name}
                                </td>
                                <td className={`py-2 px-4 text-right ${darkMode ? 'text-gray-200' : 'text-gray-900'}`}>
                                  {formatNumber(marketer.transaction_count)}
                                </td>
                                <td className={`py-2 px-4 text-right ${darkMode ? 'text-gray-200' : 'text-gray-900'}`}>
                                  {formatCurrency(marketer.acquisition_cost)}
                                </td>
                                <td className={`py-2 px-4 text-right ${darkMode ? 'text-gray-200' : 'text-gray-900'}`}>
                                  {formatCurrency(marketer.shipping_charged_to_pt)}
                                </td>
                                <td className={`py-2 px-4 text-right ${darkMode ? 'text-gray-200' : 'text-gray-900'}`}>
                                  {formatCurrency(marketer.shipping_cost_actual)}
                                </td>
                                <td className={`py-2 px-4 text-right text-blue-400`}>
                                  {formatCurrency(marketer.total_pt_paid)}
                                </td>
                                {showQuickBooksComparison && showMergedView && (
                                  <>
                                    <td className={`py-2 px-4 text-right text-gray-500 border-l-2 ${darkMode ? 'border-blue-800' : 'border-blue-200'}`}>—</td>
                                    <td className={`py-2 px-4 text-right text-gray-500`}>—</td>
                                    <td className={`py-2 px-4 text-right text-gray-500`}>—</td>
                                  </>
                                )}
                                <td className={`py-2 px-4 text-right ${darkMode ? 'text-gray-200' : 'text-gray-900'}`}>
                                  {formatCurrency(marketer.profit_after_product)}
                                </td>
                                <td className="py-2 px-4 text-right text-green-400">
                                  {formatCurrency(marketer.net_profit)}
                                </td>
                              </tr>

                              {/* State Breakdown (expanded) */}
                              {isMarketerExpanded && stateData.map((state, sIdx) => (
                                <tr
                                  key={`${marketerKey}-${state.patient_state}`}
                                  className={
                                    darkMode
                                      ? (sIdx % 2 === 0 ? 'bg-gray-900' : 'bg-gray-850')
                                      : (sIdx % 2 === 0 ? 'bg-gray-50' : 'bg-white')
                                  }
                                >
                                  <td className={`py-2 px-4 pl-14 text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                                    {state.patient_state}
                                  </td>
                                  <td className={`py-2 px-4 text-right text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                                    {formatNumber(state.transaction_count)}
                                  </td>
                                  <td className={`py-2 px-4 text-right text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                                    {formatCurrency(state.acquisition_cost)}
                                  </td>
                                  <td className={`py-2 px-4 text-right text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                                    {formatCurrency(state.shipping_charged_to_pt)}
                                  </td>
                                  <td className={`py-2 px-4 text-right text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                                    {formatCurrency(state.shipping_cost_actual)}
                                  </td>
                                  <td className={`py-2 px-4 text-right text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                                    {formatCurrency(state.total_pt_paid)}
                                  </td>
                                  {showQuickBooksComparison && showMergedView && (
                                    <>
                                      <td className={`py-2 px-4 text-right text-sm text-gray-500 border-l-2 ${darkMode ? 'border-blue-800' : 'border-blue-200'}`}>—</td>
                                      <td className={`py-2 px-4 text-right text-sm text-gray-500`}>—</td>
                                      <td className={`py-2 px-4 text-right text-sm text-gray-500`}>—</td>
                                    </>
                                  )}
                                  <td className={`py-2 px-4 text-right text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                                    {formatCurrency(state.profit_after_product)}
                                  </td>
                                  <td className={`py-2 px-4 text-right text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                                    {formatCurrency(state.net_profit)}
                                  </td>
                                </tr>
                              ))}
                            </React.Fragment>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className={`p-8 text-center ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                No data available for the selected filters
              </div>
            )}
          </div>
        </div>

        {/* Separate QuickBooks Table - Only show when QB comparison is on AND merged view is off */}
        {showQuickBooksComparison && !showMergedView && data.quickbooksComparison && data.quickbooksComparison.length > 0 && (
          <div className={`rounded-lg shadow mt-8 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <h3 className={`text-xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                QuickBooks Data by {granularity.charAt(0).toUpperCase() + granularity.slice(1)} ({qbAccountingMethod} Basis)
              </h3>
              <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Note: QuickBooks combines product & shipping revenue in account 4000. Ship Rev column will show $0.00. Toggle between Cash (revenue when received) and Accrual (revenue when earned) above.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className={`sticky top-0 ${darkMode ? 'bg-gray-700' : 'bg-gray-50'}`}>
                  <tr>
                    <th className={`text-left py-3 px-4 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Period</th>
                    <th className={`text-right py-3 px-4 font-medium text-blue-500`}>QB Product Rev</th>
                    <th className={`text-right py-3 px-4 font-medium text-blue-500`}>QB Ship Rev</th>
                    <th className={`text-right py-3 px-4 font-medium text-blue-500`}>QB Total Rev</th>
                    <th className={`text-right py-3 px-4 font-medium text-blue-500`}>QB COGS</th>
                    <th className={`text-right py-3 px-4 font-medium text-blue-500`}>QB Gross Profit</th>
                    <th className={`text-right py-3 px-4 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>LifeFile Reported</th>
                    <th className={`text-right py-3 px-4 font-medium text-purple-500`}>Variance</th>
                    <th className={`text-right py-3 px-4 font-medium text-purple-500`}>Variance %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.quickbooksComparison.map((qbPeriod, idx) => {
                    const isPositiveVariance = qbPeriod.variance >= 0;
                    const varianceColor = isPositiveVariance ? 'text-green-500' : 'text-red-500';
                    return (
                      <tr
                        key={qbPeriod.period}
                        className={darkMode ? (idx % 2 === 0 ? 'bg-gray-800' : 'bg-gray-750') : (idx % 2 === 0 ? 'bg-white' : 'bg-gray-50')}
                      >
                        <td className={`py-3 px-4 font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                          {formatPeriodLabel(qbPeriod.period)}
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                          {formatCurrency(qbPeriod.quickbooks_product_revenue)}
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                          {formatCurrency(qbPeriod.quickbooks_shipping_revenue)}
                        </td>
                        <td className={`py-3 px-4 text-right font-semibold ${darkMode ? 'text-blue-300' : 'text-blue-700'}`}>
                          {formatCurrency(qbPeriod.quickbooks_revenue)}
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                          {formatCurrency(qbPeriod.quickbooks_cogs)}
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                          {formatCurrency(qbPeriod.quickbooks_gross_profit)}
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                          {formatCurrency(qbPeriod.internal_revenue)}
                        </td>
                        <td className={`py-3 px-4 text-right font-semibold ${varianceColor}`}>
                          {isPositiveVariance ? '+' : ''}{formatCurrency(qbPeriod.variance)}
                        </td>
                        <td className={`py-3 px-4 text-right font-semibold ${varianceColor}`}>
                          {isPositiveVariance ? '+' : ''}{(qbPeriod.variance_percentage ?? 0).toFixed(2)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className={`border-t-2 ${darkMode ? 'border-gray-600 bg-gray-750' : 'border-gray-300 bg-gray-100'}`}>
                  {(() => {
                    const totals = data.quickbooksComparison.reduce((acc, period) => ({
                      qb_product_revenue: acc.qb_product_revenue + (period.quickbooks_product_revenue || 0),
                      qb_shipping_revenue: acc.qb_shipping_revenue + (period.quickbooks_shipping_revenue || 0),
                      qb_total_revenue: acc.qb_total_revenue + (period.quickbooks_revenue || 0),
                      qb_cogs: acc.qb_cogs + (period.quickbooks_cogs || 0),
                      qb_gross_profit: acc.qb_gross_profit + (period.quickbooks_gross_profit || 0),
                      lifefile_revenue: acc.lifefile_revenue + (period.internal_revenue || 0),
                      variance: acc.variance + (period.variance || 0),
                    }), { qb_product_revenue: 0, qb_shipping_revenue: 0, qb_total_revenue: 0, qb_cogs: 0, qb_gross_profit: 0, lifefile_revenue: 0, variance: 0 });

                    const totalVariancePercentage = totals.qb_total_revenue !== 0
                      ? ((totals.variance / totals.qb_total_revenue) * 100)
                      : 0;
                    const isTotalPositive = totals.variance >= 0;
                    const totalVarianceColor = isTotalPositive ? 'text-green-600' : 'text-red-600';

                    return (
                      <tr className="font-bold">
                        <td className={`py-3 px-4 text-left ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                          TOTAL
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-blue-300' : 'text-blue-700'}`}>
                          {formatCurrency(totals.qb_product_revenue)}
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-blue-300' : 'text-blue-700'}`}>
                          {formatCurrency(totals.qb_shipping_revenue)}
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-blue-200' : 'text-blue-800'}`}>
                          {formatCurrency(totals.qb_total_revenue)}
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                          {formatCurrency(totals.qb_cogs)}
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                          {formatCurrency(totals.qb_gross_profit)}
                        </td>
                        <td className={`py-3 px-4 text-right ${darkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                          {formatCurrency(totals.lifefile_revenue)}
                        </td>
                        <td className={`py-3 px-4 text-right ${totalVarianceColor}`}>
                          {isTotalPositive ? '+' : ''}{formatCurrency(totals.variance)}
                        </td>
                        <td className={`py-3 px-4 text-right ${totalVarianceColor}`}>
                          {isTotalPositive ? '+' : ''}{totalVariancePercentage.toFixed(2)}%
                        </td>
                      </tr>
                    );
                  })()}
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
