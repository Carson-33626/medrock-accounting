'use client';

import { useState, useEffect, useCallback } from 'react';
import { Download, TrendingUp, DollarSign, Users, Percent } from 'lucide-react';

type Granularity = 'monthly' | 'quarterly' | 'yearly';
type AccountingMethod = 'Cash' | 'Accrual';

interface CompanyFinancials {
  location: string;
  period: string;

  // Income
  revenue: number;
  product_revenue?: number;
  shipping_revenue?: number;

  // COGS
  cogs: number;
  gross_profit: number;
  gross_margin_percent: number;

  // Expenses
  payroll_total: number;
  operating_expenses_total: number;

  // Bottom Line
  net_income: number;
  net_margin_percent: number;

  // Metadata
  accounting_method: AccountingMethod;
  cached: boolean;
}

interface CompanySummaryData {
  locations: CompanyFinancials[];
  totals: CompanyFinancials;
  period: string;
  granularity: Granularity;
  accounting_method: AccountingMethod;
}

export function CompanySummaryDashboard() {
  // State
  const [data, setData] = useState<CompanySummaryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setMonth(date.getMonth() - 6); // Last 6 months
    return date.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => {
    const date = new Date();
    date.setDate(0); // Last day of previous month
    return date.toISOString().split('T')[0];
  });
  const [granularity, setGranularity] = useState<Granularity>('monthly');
  const [accountingMethod, setAccountingMethod] = useState<AccountingMethod>('Cash');

  // Fetch data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        startDate,
        endDate,
        granularity,
        accountingMethod,
      });

      const response = await fetch(`/api/company-summary?${params}`);

      if (!response.ok) {
        throw new Error('Failed to fetch company summary data');
      }

      const result = await response.json();
      setData(result);
    } catch (err) {
      console.error('Error fetching company summary:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, granularity, accountingMethod]);

  // Load data on mount and when filters change
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Format currency
  const formatCurrency = (value: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  // Format percentage
  const formatPercent = (value: number): string => {
    return `${value.toFixed(1)}%`;
  };

  // Export CSV
  const exportCSV = () => {
    if (!data) return;

    const lines = [
      'COMPANY PROFITABILITY SUMMARY',
      `Generated: ${new Date().toLocaleString()}`,
      `Period: ${startDate} to ${endDate}`,
      `Granularity: ${granularity}`,
      `Accounting Method: ${accountingMethod}`,
      '',
      'Location,Revenue,COGS,Gross Profit,Gross Margin %,Payroll,Operating Expenses,Net Income,Net Margin %',
    ];

    // Add location rows
    data.locations.forEach(loc => {
      lines.push([
        loc.location,
        loc.revenue.toFixed(2),
        loc.cogs.toFixed(2),
        loc.gross_profit.toFixed(2),
        loc.gross_margin_percent.toFixed(2),
        loc.payroll_total.toFixed(2),
        loc.operating_expenses_total.toFixed(2),
        loc.net_income.toFixed(2),
        loc.net_margin_percent.toFixed(2),
      ].join(','));
    });

    // Add totals row
    lines.push('');
    lines.push([
      'TOTAL',
      data.totals.revenue.toFixed(2),
      data.totals.cogs.toFixed(2),
      data.totals.gross_profit.toFixed(2),
      data.totals.gross_margin_percent.toFixed(2),
      data.totals.payroll_total.toFixed(2),
      data.totals.operating_expenses_total.toFixed(2),
      data.totals.net_income.toFixed(2),
      data.totals.net_margin_percent.toFixed(2),
    ].join(','));

    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `company-summary-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Company Summary
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            Executive financial overview by location
          </p>
        </div>

        <button
          onClick={exportCSV}
          disabled={!data || loading}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 p-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Start Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Start Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
            />
          </div>

          {/* End Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              End Date
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
            />
          </div>

          {/* Granularity */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Granularity
            </label>
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as Granularity)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>

          {/* Accounting Method */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Accounting Method
            </label>
            <select
              value={accountingMethod}
              onChange={(e) => setAccountingMethod(e.target.value as AccountingMethod)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
            >
              <option value="Cash">Cash Basis</option>
              <option value="Accrual">Accrual Basis</option>
            </select>
          </div>
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 p-12 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="text-gray-600 dark:text-gray-400 mt-4">Loading company data...</p>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-6">
          <p className="text-red-800 dark:text-red-200">Error: {error}</p>
        </div>
      )}

      {/* KPI Cards */}
      {data && !loading && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 p-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                <DollarSign className="w-6 h-6 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Total Revenue</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">
                  {formatCurrency(data.totals.revenue)}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 p-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-green-100 dark:bg-green-900/30 rounded-lg">
                <TrendingUp className="w-6 h-6 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Gross Profit</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">
                  {formatCurrency(data.totals.gross_profit)}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 p-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-purple-100 dark:bg-purple-900/30 rounded-lg">
                <Users className="w-6 h-6 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Total Payroll</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">
                  {formatCurrency(data.totals.payroll_total)}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 p-6">
            <div className="flex items-center gap-3">
              <div className={`p-3 rounded-lg ${
                data.totals.net_income >= 0
                  ? 'bg-emerald-100 dark:bg-emerald-900/30'
                  : 'bg-red-100 dark:bg-red-900/30'
              }`}>
                <Percent className={`w-6 h-6 ${
                  data.totals.net_income >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400'
                }`} />
              </div>
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Net Income</p>
                <p className={`text-2xl font-bold ${
                  data.totals.net_income >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400'
                }`}>
                  {formatCurrency(data.totals.net_income)}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Location Comparison Table */}
      {data && !loading && (
        <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 overflow-hidden">
          <div className="p-6 border-b border-gray-200 dark:border-slate-700">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              Location Comparison
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Complete P&L by territory
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-slate-900/50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Location
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Revenue
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    COGS
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Gross Profit
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Gross %
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Payroll
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Operating
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Net Income
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Net %
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-slate-700">
                {data.locations.map((location) => (
                  <tr key={location.location} className="hover:bg-gray-50 dark:hover:bg-slate-900/30">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-white">
                      {location.location}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900 dark:text-white">
                      {formatCurrency(location.revenue)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-600 dark:text-gray-400">
                      {formatCurrency(location.cogs)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900 dark:text-white font-medium">
                      {formatCurrency(location.gross_profit)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-600 dark:text-gray-400">
                      {formatPercent(location.gross_margin_percent)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-600 dark:text-gray-400">
                      {formatCurrency(location.payroll_total)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-600 dark:text-gray-400">
                      {formatCurrency(location.operating_expenses_total)}
                    </td>
                    <td className={`px-6 py-4 whitespace-nowrap text-sm text-right font-medium ${
                      location.net_income >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}>
                      {formatCurrency(location.net_income)}
                    </td>
                    <td className={`px-6 py-4 whitespace-nowrap text-sm text-right ${
                      location.net_margin_percent >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}>
                      {formatPercent(location.net_margin_percent)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-100 dark:bg-slate-900/50">
                <tr className="font-bold">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                    TOTAL
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900 dark:text-white">
                    {formatCurrency(data.totals.revenue)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900 dark:text-white">
                    {formatCurrency(data.totals.cogs)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900 dark:text-white">
                    {formatCurrency(data.totals.gross_profit)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900 dark:text-white">
                    {formatPercent(data.totals.gross_margin_percent)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900 dark:text-white">
                    {formatCurrency(data.totals.payroll_total)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900 dark:text-white">
                    {formatCurrency(data.totals.operating_expenses_total)}
                  </td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm text-right ${
                    data.totals.net_income >= 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}>
                    {formatCurrency(data.totals.net_income)}
                  </td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm text-right ${
                    data.totals.net_margin_percent >= 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}>
                    {formatPercent(data.totals.net_margin_percent)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
