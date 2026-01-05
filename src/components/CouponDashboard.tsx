'use client';

import { useEffect, useState, useCallback } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar
} from 'recharts';

interface Stats {
  totalRedemptions: number;
  totalDiscount: number;
  uniqueCoupons: number;
  avgDiscount: number;
}

interface PeriodData {
  period: string;
  redemptions: number;
  discountValue: number;
}

type Granularity = 'daily' | 'monthly' | 'quarterly' | 'yearly';

interface TopCoupon {
  code: string;
  count: number;
  totalDiscount: number;
}

interface Redemption {
  id: string;
  couponCode: string;
  discountAmount: number;
  redeemedAt: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  source: 'historical' | 'live';
}

interface CouponData {
  stats: Stats;
  dateRange: { earliest: string; latest: string };
  sourceBreakdown?: { historical: number; live: number };
  periodData: PeriodData[];
  granularity: Granularity;
  topCoupons: TopCoupon[];
  redemptions: Redemption[];
  allCouponCodes: string[];
}

interface Filters {
  startDate: string;
  endDate: string;
  source: 'all' | 'historical' | 'live';
  couponCode: string;
}

export default function CouponDashboard() {
  const [data, setData] = useState<CouponData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartType, setChartType] = useState<'redemptions' | 'discount'>('redemptions');
  const [granularity, setGranularity] = useState<Granularity>('monthly');
  const { darkMode } = useDarkMode();
  const [filters, setFilters] = useState<Filters>({
    startDate: '',
    endDate: '',
    source: 'all',
    couponCode: ''
  });
  const [appliedFilters, setAppliedFilters] = useState<Filters>(filters);
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fetchData = useCallback(async (currentFilters: Filters, currentGranularity: Granularity) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (currentFilters.startDate) params.set('startDate', currentFilters.startDate);
      if (currentFilters.endDate) params.set('endDate', currentFilters.endDate);
      if (currentFilters.source !== 'all') params.set('source', currentFilters.source);
      if (currentFilters.couponCode) params.set('couponCode', currentFilters.couponCode);
      params.set('granularity', currentGranularity);

      const url = `/api/coupons${params.toString() ? `?${params.toString()}` : ''}`;
      const res = await fetch(url);
      const result = await res.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(appliedFilters, granularity);
  }, [appliedFilters, granularity, fetchData]);

  const handleApplyFilters = () => {
    setAppliedFilters({ ...filters });
  };

  const handleGranularityChange = (newGranularity: Granularity) => {
    setGranularity(newGranularity);
  };

  const handleResetFilters = () => {
    const defaultFilters: Filters = {
      startDate: '',
      endDate: '',
      source: 'all',
      couponCode: ''
    };
    setFilters(defaultFilters);
    setAppliedFilters(defaultFilters);
  };

  const hasActiveFilters = appliedFilters.startDate || appliedFilters.endDate ||
    appliedFilters.source !== 'all' || appliedFilters.couponCode;

  const downloadCSV = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const exportTransactions = async () => {
    if (!data) return;
    setExporting(true);
    setExportDropdownOpen(false);

    try {
      // Fetch all data for export
      const params = new URLSearchParams();
      if (appliedFilters.startDate) params.set('startDate', appliedFilters.startDate);
      if (appliedFilters.endDate) params.set('endDate', appliedFilters.endDate);
      if (appliedFilters.source !== 'all') params.set('source', appliedFilters.source);
      if (appliedFilters.couponCode) params.set('couponCode', appliedFilters.couponCode);
      params.set('export', 'true');

      const url = `/api/coupons${params.toString() ? `?${params.toString()}` : ''}`;
      const res = await fetch(url);
      const exportData = await res.json();

      const headers = ['Date', 'Coupon Code', 'Discount Amount', 'First Name', 'Last Name', 'Email', 'Source'];
      const rows = exportData.redemptions.map((r: Redemption) => [
        r.redeemedAt?.substring(0, 10) || '',
        r.couponCode,
        r.discountAmount.toFixed(2),
        r.firstName || '',
        r.lastName || '',
        r.email || '',
        r.source
      ]);

      const csv = [headers.join(','), ...rows.map((row: string[]) => row.map(cell => `"${cell}"`).join(','))].join('\n');
      const dateStr = new Date().toISOString().split('T')[0];
      downloadCSV(csv, `coupon-transactions-${dateStr}.csv`);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setExporting(false);
    }
  };

  const exportSummary = () => {
    if (!data) return;
    setExportDropdownOpen(false);

    // Summary stats
    const summaryLines = [
      'COUPON REDEMPTIONS SUMMARY',
      `Generated: ${new Date().toLocaleString()}`,
      `Date Range: ${data.dateRange.earliest?.substring(0, 10)} to ${data.dateRange.latest?.substring(0, 10)}`,
      '',
      'OVERVIEW',
      `Total Redemptions,${data.stats.totalRedemptions}`,
      `Total Discount Value,$${data.stats.totalDiscount.toFixed(2)}`,
      `Unique Coupons,${data.stats.uniqueCoupons}`,
      `Average Discount,$${data.stats.avgDiscount.toFixed(2)}`,
      ''
    ];

    if (data.sourceBreakdown) {
      summaryLines.push('SOURCE BREAKDOWN');
      summaryLines.push(`Historical (WordPress),${data.sourceBreakdown.historical}`);
      summaryLines.push(`Live (MongoDB),${data.sourceBreakdown.live}`);
      summaryLines.push('');
    }

    // Period data
    const periodLabel = granularity.charAt(0).toUpperCase() + granularity.slice(1);
    summaryLines.push(`${periodLabel.toUpperCase()} DATA`);
    summaryLines.push('Period,Redemptions,Discount Value');
    data.periodData.forEach((p: PeriodData) => {
      summaryLines.push(`${p.period},${p.redemptions},$${p.discountValue.toFixed(2)}`);
    });
    summaryLines.push('');

    // Top coupons
    summaryLines.push('TOP COUPONS');
    summaryLines.push('Code,Uses,Total Discount');
    data.topCoupons.forEach(c => {
      summaryLines.push(`${c.code},${c.count},$${c.totalDiscount.toFixed(2)}`);
    });

    const csv = summaryLines.join('\n');
    const dateStr = new Date().toISOString().split('T')[0];
    downloadCSV(csv, `coupon-summary-${dateStr}.csv`);
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl">Loading coupon data...</div>
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

  const formatPeriod = (period: string, gran: Granularity) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    switch (gran) {
      case 'yearly':
        return period; // Just the year
      case 'quarterly':
        return period; // YYYY-Q1 format
      case 'daily': {
        const [, month, day] = period.split('-');
        return `${months[parseInt(month) - 1]} ${day}`;
      }
      case 'monthly':
      default: {
        const [year, m] = period.split('-');
        return `${months[parseInt(m) - 1]} ${year.slice(2)}`;
      }
    }
  };

  const chartData = data.periodData.map(d => ({
    ...d,
    periodLabel: formatPeriod(d.period, granularity)
  }));

  return (
    <div className={`min-h-screen p-8 transition-colors ${darkMode ? 'bg-gray-900' : 'bg-gray-50'}`}>
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h1 className={`text-3xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>AMY</h1>
            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Accounting Metrics & Yields</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Export dropdown */}
            <div className="relative">
              <button
                onClick={() => setExportDropdownOpen(!exportDropdownOpen)}
                disabled={exporting}
                className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {exporting ? 'Exporting...' : 'Export'}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {exportDropdownOpen && (
                <div className={`absolute right-0 mt-2 w-48 rounded-lg shadow-lg border py-1 z-10 ${
                  darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
                }`}>
                  <button
                    onClick={exportTransactions}
                    className={`w-full text-left px-4 py-2 text-sm ${
                      darkMode ? 'text-gray-200 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    CSV - Transactions
                  </button>
                  <button
                    onClick={exportSummary}
                    className={`w-full text-left px-4 py-2 text-sm ${
                      darkMode ? 'text-gray-200 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    CSV - Summary
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <h2 className={`text-2xl font-semibold mb-2 ${darkMode ? 'text-gray-100' : 'text-gray-800'}`}>Coupon Redemptions</h2>
        <p className={`${darkMode ? 'text-gray-400' : 'text-gray-600'} ${data.sourceBreakdown ? 'mb-2' : 'mb-4'}`}>
          Data from {data.dateRange.earliest?.substring(0, 10)} to {data.dateRange.latest?.substring(0, 10)}
        </p>
        {data.sourceBreakdown && (
          <p className={`text-sm mb-4 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
            Sources: {data.sourceBreakdown.historical.toLocaleString()} historical (WordPress) + {data.sourceBreakdown.live.toLocaleString()} live (MongoDB)
          </p>
        )}

        {/* Filters */}
        <div className={`rounded-lg shadow p-6 mb-8 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="flex items-center justify-between mb-4">
            <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Filters</h2>
            {hasActiveFilters && (
              <span className="text-sm text-blue-500 font-medium">Filters applied</span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>Start Date</label>
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
              <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>End Date</label>
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
              <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>Data Source</label>
              <select
                value={filters.source}
                onChange={(e) => setFilters({ ...filters, source: e.target.value as Filters['source'] })}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                  darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                }`}
              >
                <option value="all">All Sources</option>
                <option value="historical">Historical (WordPress)</option>
                <option value="live">Live (MongoDB)</option>
              </select>
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>Coupon Code</label>
              <select
                value={filters.couponCode}
                onChange={(e) => setFilters({ ...filters, couponCode: e.target.value })}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                  darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                }`}
              >
                <option value="">All Coupons</option>
                {data.allCouponCodes.map(code => (
                  <option key={code} value={code}>{code}</option>
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
            <div className={`text-sm font-medium ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Total Redemptions</div>
            <div className={`text-3xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>{data.stats.totalRedemptions.toLocaleString()}</div>
          </div>
          <div className={`rounded-lg shadow p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className={`text-sm font-medium ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Total Discount Value</div>
            <div className="text-3xl font-bold text-green-500">${data.stats.totalDiscount.toLocaleString()}</div>
          </div>
          <div className={`rounded-lg shadow p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className={`text-sm font-medium ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Unique Coupons</div>
            <div className={`text-3xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>{data.stats.uniqueCoupons}</div>
          </div>
          <div className={`rounded-lg shadow p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className={`text-sm font-medium ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Avg Discount</div>
            <div className={`text-3xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>${data.stats.avgDiscount.toFixed(2)}</div>
          </div>
        </div>

        {/* Line Chart */}
        <div className={`rounded-lg shadow p-6 mb-8 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="flex justify-between items-center mb-4">
            <h2 className={`text-xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {granularity.charAt(0).toUpperCase() + granularity.slice(1)} Trends
            </h2>
            <div className="flex gap-4">
              {/* Granularity selector */}
              <div className={`flex gap-1 rounded-lg p-1 ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                {(['daily', 'monthly', 'quarterly', 'yearly'] as Granularity[]).map((g) => (
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
              {/* Chart type selector */}
              <div className="flex gap-2">
                <button
                  onClick={() => setChartType('redemptions')}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    chartType === 'redemptions'
                      ? 'bg-blue-600 text-white'
                      : darkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Redemptions
                </button>
                <button
                  onClick={() => setChartType('discount')}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    chartType === 'discount'
                      ? 'bg-blue-600 text-white'
                      : darkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Discount Value
                </button>
              </div>
            </div>
          </div>
          <div className="h-80">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#374151' : '#e5e7eb'} />
                  <XAxis
                    dataKey="periodLabel"
                    tick={{ fontSize: 11, fill: darkMode ? '#9ca3af' : '#374151' }}
                    interval={granularity === 'daily' ? Math.max(0, Math.floor(chartData.length / 15) - 1) : 0}
                    angle={-45}
                    textAnchor="end"
                    height={60}
                    stroke={darkMode ? '#4b5563' : '#d1d5db'}
                  />
                  <YAxis tick={{ fontSize: 12, fill: darkMode ? '#9ca3af' : '#374151' }} stroke={darkMode ? '#4b5563' : '#d1d5db'} />
                  <Tooltip
                    formatter={(value) =>
                      chartType === 'discount' ? `$${Number(value).toFixed(2)}` : value
                    }
                    labelFormatter={(label) => `Period: ${label}`}
                    contentStyle={{
                      backgroundColor: darkMode ? '#1f2937' : '#ffffff',
                      border: `1px solid ${darkMode ? '#374151' : '#e5e7eb'}`,
                      borderRadius: '8px',
                      color: darkMode ? '#f3f4f6' : '#111827'
                    }}
                  />
                  <Legend wrapperStyle={{ color: darkMode ? '#9ca3af' : '#374151' }} />
                  {chartType === 'redemptions' ? (
                    <Line
                      type="monotone"
                      dataKey="redemptions"
                      stroke="#3B82F6"
                      strokeWidth={2}
                      dot={chartData.length <= 31 ? { fill: '#3B82F6', strokeWidth: 2, r: 4 } : false}
                      name="Redemptions"
                    />
                  ) : (
                    <Line
                      type="monotone"
                      dataKey="discountValue"
                      stroke="#10B981"
                      strokeWidth={2}
                      dot={chartData.length <= 31 ? { fill: '#10B981', strokeWidth: 2, r: 4 } : false}
                      name="Discount Value ($)"
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className={`flex items-center justify-center h-full ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                No data available for the selected filters
              </div>
            )}
          </div>
        </div>

        {/* Top Coupons */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className={`rounded-lg shadow p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <h2 className={`text-xl font-semibold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Top Coupon Codes</h2>
            <div className="h-80">
              {data.topCoupons.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.topCoupons.slice(0, 10)} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#374151' : '#e5e7eb'} />
                    <XAxis type="number" tick={{ fontSize: 12, fill: darkMode ? '#9ca3af' : '#374151' }} stroke={darkMode ? '#4b5563' : '#d1d5db'} />
                    <YAxis dataKey="code" type="category" tick={{ fontSize: 11, fill: darkMode ? '#9ca3af' : '#374151' }} width={100} stroke={darkMode ? '#4b5563' : '#d1d5db'} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: darkMode ? '#1f2937' : '#ffffff',
                        border: `1px solid ${darkMode ? '#374151' : '#e5e7eb'}`,
                        borderRadius: '8px',
                        color: darkMode ? '#f3f4f6' : '#111827'
                      }}
                    />
                    <Bar dataKey="count" fill="#3B82F6" name="Redemptions" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className={`flex items-center justify-center h-full ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  No coupons found for the selected filters
                </div>
              )}
            </div>
          </div>

          <div className={`rounded-lg shadow p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <h2 className={`text-xl font-semibold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Coupon Details</h2>
            <div className="overflow-y-auto max-h-80">
              {data.topCoupons.length > 0 ? (
                <table className="w-full text-sm">
                  <thead className={`sticky top-0 ${darkMode ? 'bg-gray-700' : 'bg-gray-50'}`}>
                    <tr>
                      <th className={`text-left py-2 px-3 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Code</th>
                      <th className={`text-right py-2 px-3 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Uses</th>
                      <th className={`text-right py-2 px-3 font-medium ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Total Discount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topCoupons.map((coupon, i) => (
                      <tr key={coupon.code} className={
                        darkMode
                          ? (i % 2 === 0 ? 'bg-gray-800' : 'bg-gray-750')
                          : (i % 2 === 0 ? 'bg-white' : 'bg-gray-50')
                      }>
                        <td className={`py-2 px-3 font-mono ${darkMode ? 'text-gray-200' : 'text-gray-900'}`}>{coupon.code}</td>
                        <td className={`py-2 px-3 text-right ${darkMode ? 'text-gray-200' : 'text-gray-900'}`}>{coupon.count}</td>
                        <td className="py-2 px-3 text-right text-green-500">
                          ${coupon.totalDiscount.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className={`flex items-center justify-center h-full ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  No coupons found for the selected filters
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
