import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase-admin';

interface MarketerMonthlyRow {
  id: number;
  location: string;
  marketer_name: string;
  patient_state: string;
  year: number;
  month: number;
  transaction_count: number;
  acquisition_cost: number;
  shipping_charged_to_pt: number;
  shipping_cost_actual: number;
  total_pt_paid: number;
  profit_after_product: number;
  net_profit: number;
  created_at: string;
  updated_at: string;
}

type Granularity = 'monthly' | 'quarterly' | 'yearly';

interface AggregatedData {
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

// Get period key based on granularity
function getPeriodKey(year: number, month: number, granularity: Granularity): string {
  switch (granularity) {
    case 'yearly':
      return `${year}`;
    case 'quarterly': {
      const quarter = Math.ceil(month / 3);
      return `${year}-Q${quarter}`;
    }
    case 'monthly':
    default:
      return `${year}-${month.toString().padStart(2, '0')}`;
  }
}

// Aggregate data by marketer and period
function aggregateByMarketer(
  rows: MarketerMonthlyRow[],
  granularity: Granularity,
  includeStates: boolean
): AggregatedData[] {
  const aggregates = new Map<string, AggregatedData>();

  rows.forEach(row => {
    const period = getPeriodKey(row.year, row.month, granularity);
    const key = includeStates
      ? `${period}|${row.marketer_name}|${row.patient_state}`
      : `${period}|${row.marketer_name}`;

    const existing = aggregates.get(key) || {
      period,
      marketer_name: row.marketer_name,
      patient_state: includeStates ? row.patient_state : undefined,
      transaction_count: 0,
      acquisition_cost: 0,
      shipping_charged_to_pt: 0,
      shipping_cost_actual: 0,
      total_pt_paid: 0,
      profit_after_product: 0,
      net_profit: 0,
    };

    existing.transaction_count += row.transaction_count;
    existing.acquisition_cost += Number(row.acquisition_cost);
    existing.shipping_charged_to_pt += Number(row.shipping_charged_to_pt);
    existing.shipping_cost_actual += Number(row.shipping_cost_actual);
    existing.total_pt_paid += Number(row.total_pt_paid);
    existing.profit_after_product += Number(row.profit_after_product);
    existing.net_profit += Number(row.net_profit);

    aggregates.set(key, existing);
  });

  return [...aggregates.values()];
}

// Get period totals for the chart
function getPeriodTotals(rows: MarketerMonthlyRow[], granularity: Granularity) {
  const totals = new Map<string, {
    period: string;
    transaction_count: number;
    net_profit: number;
    total_pt_paid: number;
  }>();

  rows.forEach(row => {
    const period = getPeriodKey(row.year, row.month, granularity);
    const existing = totals.get(period) || {
      period,
      transaction_count: 0,
      net_profit: 0,
      total_pt_paid: 0,
    };

    existing.transaction_count += row.transaction_count;
    existing.net_profit += Number(row.net_profit);
    existing.total_pt_paid += Number(row.total_pt_paid);

    totals.set(period, existing);
  });

  return [...totals.values()].sort((a, b) => a.period.localeCompare(b.period));
}

export async function GET(request: NextRequest) {
  try {
    const supabase = getAdminClient();
    const { searchParams } = new URL(request.url);

    // Parse filters
    const location = searchParams.get('location');
    const year = searchParams.get('year');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const marketer = searchParams.get('marketer');
    const granularity = (searchParams.get('granularity') || 'monthly') as Granularity;

    // Build query
    let query = supabase
      .from('amy_marketer_monthly')
      .select('*')
      .order('year', { ascending: false })
      .order('month', { ascending: false });

    // Apply filters
    if (location && location !== 'all') {
      query = query.eq('location', location);
    }

    if (year) {
      query = query.eq('year', parseInt(year));
    }

    if (startDate) {
      const [y, m] = startDate.split('-').map(Number);
      // Filter: year > startYear OR (year = startYear AND month >= startMonth)
      query = query.or(`year.gt.${y},and(year.eq.${y},month.gte.${m})`);
    }

    if (endDate) {
      const [y, m] = endDate.split('-').map(Number);
      // Filter: year < endYear OR (year = endYear AND month <= endMonth)
      query = query.or(`year.lt.${y},and(year.eq.${y},month.lte.${m})`);
    }

    if (marketer) {
      query = query.eq('marketer_name', marketer);
    }

    const { data: rows, error } = await query;

    if (error) {
      console.error('Supabase error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const typedRows = rows as MarketerMonthlyRow[];

    // Get unique marketers and locations for filters
    const marketers = [...new Set(typedRows.map(r => r.marketer_name))].sort();
    const locations = [...new Set(typedRows.map(r => r.location))].sort();

    // Get date range
    const years = [...new Set(typedRows.map(r => r.year))].sort((a, b) => b - a);
    const dateRange = {
      minYear: Math.min(...years),
      maxYear: Math.max(...years),
    };

    // Calculate totals
    const stats = {
      totalTransactions: typedRows.reduce((sum, r) => sum + r.transaction_count, 0),
      totalNetProfit: typedRows.reduce((sum, r) => sum + Number(r.net_profit), 0),
      totalRevenue: typedRows.reduce((sum, r) => sum + Number(r.total_pt_paid), 0),
      totalAcquisitionCost: typedRows.reduce((sum, r) => sum + Number(r.acquisition_cost), 0),
      uniqueMarketers: marketers.length,
    };

    // Aggregate by marketer (without state breakdown for main table)
    const marketerData = aggregateByMarketer(typedRows, granularity, false);

    // Group by period for expandable view
    const byPeriod = new Map<string, AggregatedData[]>();
    marketerData.forEach(data => {
      const existing = byPeriod.get(data.period) || [];
      existing.push(data);
      byPeriod.set(data.period, existing);
    });

    // Sort each period's marketers by net profit
    byPeriod.forEach((marketers, period) => {
      byPeriod.set(period, marketers.sort((a, b) => b.net_profit - a.net_profit));
    });

    // Convert to array sorted by period (newest first)
    const periodGroups = [...byPeriod.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([period, marketers]) => ({
        period,
        marketers,
        totals: {
          transaction_count: marketers.reduce((sum, m) => sum + m.transaction_count, 0),
          acquisition_cost: marketers.reduce((sum, m) => sum + m.acquisition_cost, 0),
          shipping_charged_to_pt: marketers.reduce((sum, m) => sum + m.shipping_charged_to_pt, 0),
          shipping_cost_actual: marketers.reduce((sum, m) => sum + m.shipping_cost_actual, 0),
          total_pt_paid: marketers.reduce((sum, m) => sum + m.total_pt_paid, 0),
          profit_after_product: marketers.reduce((sum, m) => sum + m.profit_after_product, 0),
          net_profit: marketers.reduce((sum, m) => sum + m.net_profit, 0),
        },
      }));

    // Get state breakdown for each marketer/period (for drill-down)
    const stateBreakdown = aggregateByMarketer(typedRows, granularity, true);
    const statesByMarketerPeriod = new Map<string, AggregatedData[]>();
    stateBreakdown.forEach(data => {
      const key = `${data.period}|${data.marketer_name}`;
      const existing = statesByMarketerPeriod.get(key) || [];
      existing.push(data);
      statesByMarketerPeriod.set(key, existing);
    });

    // Sort states by net profit
    statesByMarketerPeriod.forEach((states, key) => {
      statesByMarketerPeriod.set(key, states.sort((a, b) => b.net_profit - a.net_profit));
    });

    // Chart data
    const chartData = getPeriodTotals(typedRows, granularity);

    return NextResponse.json({
      stats,
      dateRange,
      marketers,
      locations,
      periodGroups,
      stateBreakdown: Object.fromEntries(statesByMarketerPeriod),
      chartData,
      granularity,
    });
  } catch (error) {
    console.error('Error fetching marketer profitability:', error);
    return NextResponse.json(
      { error: 'Failed to load marketer profitability data' },
      { status: 500 }
    );
  }
}
