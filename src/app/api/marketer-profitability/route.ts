import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase-admin';
import { getRevenueByPeriod, getRevenueAllLocations, isConnected, type Location } from '@/lib/quickbooks-multi';

// Route segment config - allow dynamic rendering with our own cache
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// QuickBooks Response Cache
// Simple in-memory cache with TTL to reduce API calls
interface CacheEntry {
  data: any;
  timestamp: number;
}

const qbCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache

function getCacheKey(location: string | null, startDate: string, endDate: string, granularity: string): string {
  return `${location || 'all'}:${startDate}:${endDate}:${granularity}`;
}

function getCachedQBData(key: string): any | null {
  const entry = qbCache.get(key);
  if (!entry) return null;

  const age = Date.now() - entry.timestamp;
  if (age > CACHE_TTL_MS) {
    qbCache.delete(key);
    return null;
  }

  console.log(`[QB Cache] HIT for key: ${key} (age: ${Math.round(age / 1000)}s)`);
  return entry.data;
}

function setCachedQBData(key: string, data: any): void {
  qbCache.set(key, { data, timestamp: Date.now() });
  console.log(`[QB Cache] SET for key: ${key}`);

  // Periodic cleanup: remove expired entries when cache grows
  if (qbCache.size > 50) {
    cleanExpiredCache();
  }
}

function cleanExpiredCache(): void {
  const now = Date.now();
  let removed = 0;

  for (const [key, entry] of qbCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      qbCache.delete(key);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[QB Cache] Cleaned ${removed} expired entries. Current size: ${qbCache.size}`);
  }
}

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
      totalTransactions: typedRows.reduce((sum: number, r) => sum + r.transaction_count, 0),
      totalNetProfit: typedRows.reduce((sum: number, r) => sum + Number(r.net_profit), 0),
      totalRevenue: typedRows.reduce((sum: number, r) => sum + Number(r.total_pt_paid), 0),
      totalAcquisitionCost: typedRows.reduce((sum: number, r) => sum + Number(r.acquisition_cost), 0),
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
          transaction_count: marketers.reduce((sum: number, m) => sum + m.transaction_count, 0),
          acquisition_cost: marketers.reduce((sum: number, m) => sum + m.acquisition_cost, 0),
          shipping_charged_to_pt: marketers.reduce((sum: number, m) => sum + m.shipping_charged_to_pt, 0),
          shipping_cost_actual: marketers.reduce((sum: number, m) => sum + m.shipping_cost_actual, 0),
          total_pt_paid: marketers.reduce((sum: number, m) => sum + m.total_pt_paid, 0),
          profit_after_product: marketers.reduce((sum: number, m) => sum + m.profit_after_product, 0),
          net_profit: marketers.reduce((sum: number, m) => sum + m.net_profit, 0),
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

    // Optionally fetch QuickBooks revenue comparison
    const includeQB = searchParams.get('includeQuickBooks') === 'true';
    let quickbooksData: any = null;
    let quickbooksComparison: any = null;

    if (includeQB && startDate && endDate) {
      try {
        // Determine which location(s) to fetch QB data for
        const qbLocation = (location && location !== 'all' ? location : null) as Location | null;

        if (!qbLocation) {
          // Check cache first
          const cacheKey = getCacheKey(null, startDate, endDate, granularity);
          let allQBRevenue = getCachedQBData(cacheKey);

          if (!allQBRevenue) {
            // Cache miss - Fetch ALL locations data
            console.log('[QB Cache] MISS - Fetching from API...');
            allQBRevenue = await getRevenueAllLocations({
              startDate,
              endDate,
              granularity,
            });
            // Store in cache
            setCachedQBData(cacheKey, allQBRevenue);
          }

          // Aggregate revenue by period from all locations
          const aggregatedByPeriod = new Map<string, { revenue: number; cost_of_goods: number; gross_profit: number }>();

          (Object.values(allQBRevenue) as Array<Array<{ period: string; revenue: number; cost_of_goods: number; gross_profit: number }>>).forEach(locationData => {
            locationData.forEach(item => {
              const existing = aggregatedByPeriod.get(item.period) || { revenue: 0, cost_of_goods: 0, gross_profit: 0 };
              existing.revenue += item.revenue;
              existing.cost_of_goods += item.cost_of_goods;
              existing.gross_profit += item.gross_profit;
              aggregatedByPeriod.set(item.period, existing);
            });
          });

          quickbooksData = {
            connected: true,
            location: 'all',
            message: 'Aggregated from all connected locations',
          };

          // Create comparison map
          quickbooksComparison = periodGroups.map(group => {
            const qbPeriod = aggregatedByPeriod.get(group.period);

            if (!qbPeriod) {
              return {
                period: group.period,
                internal_revenue: group.totals.total_pt_paid,
                quickbooks_revenue: 0,
                quickbooks_cogs: 0,
                quickbooks_gross_profit: 0,
                variance: group.totals.total_pt_paid,
                variance_percentage: 0,
              };
            }

            const variance = group.totals.total_pt_paid - qbPeriod.revenue;
            const variancePercentage =
              qbPeriod.revenue !== 0
                ? ((variance / qbPeriod.revenue) * 100)
                : 0;

            return {
              period: group.period,
              internal_revenue: group.totals.total_pt_paid,
              quickbooks_revenue: qbPeriod.revenue,
              quickbooks_cogs: qbPeriod.cost_of_goods,
              quickbooks_gross_profit: qbPeriod.gross_profit,
              variance,
              variance_percentage: variancePercentage,
            };
          });
        } else {
          // Single location
          const qbConnected = await isConnected(qbLocation);

          if (qbConnected) {
            // Check cache first
            const cacheKey = getCacheKey(qbLocation, startDate, endDate, granularity);
            let qbRevenue = getCachedQBData(cacheKey);

            if (!qbRevenue) {
              // Cache miss - Fetch QB revenue data for this location
              console.log('[QB Cache] MISS - Fetching from API...');
              qbRevenue = await getRevenueByPeriod({
                location: qbLocation,
                startDate,
                endDate,
                granularity,
              });
              // Store in cache
              setCachedQBData(cacheKey, qbRevenue);
            }

            quickbooksData = {
              connected: true,
              location: qbLocation,
              data: qbRevenue,
              totals: {
                revenue: qbRevenue.reduce((sum: number, item: { revenue: number; product_revenue: number; shipping_revenue: number; cost_of_goods: number; gross_profit: number; period: string }) => sum + item.revenue, 0),
                product_revenue: qbRevenue.reduce((sum: number, item: { revenue: number; product_revenue: number; shipping_revenue: number; cost_of_goods: number; gross_profit: number; period: string }) => sum + item.product_revenue, 0),
                shipping_revenue: qbRevenue.reduce((sum: number, item: { revenue: number; product_revenue: number; shipping_revenue: number; cost_of_goods: number; gross_profit: number; period: string }) => sum + item.shipping_revenue, 0),
                cost_of_goods: qbRevenue.reduce((sum: number, item: { revenue: number; product_revenue: number; shipping_revenue: number; cost_of_goods: number; gross_profit: number; period: string }) => sum + item.cost_of_goods, 0),
                gross_profit: qbRevenue.reduce((sum: number, item: { revenue: number; product_revenue: number; shipping_revenue: number; cost_of_goods: number; gross_profit: number; period: string }) => sum + item.gross_profit, 0),
              },
            };

            // Create comparison map by period
            const qbByPeriod = new Map<string, { revenue: number; product_revenue: number; shipping_revenue: number; cost_of_goods: number; gross_profit: number; period: string }>(qbRevenue.map((item: { revenue: number; product_revenue: number; shipping_revenue: number; cost_of_goods: number; gross_profit: number; period: string }) => [item.period, item]));

            quickbooksComparison = periodGroups.map(group => {
              const qbPeriod = qbByPeriod.get(group.period);

              if (!qbPeriod) {
                return {
                  period: group.period,
                  internal_revenue: group.totals.total_pt_paid,
                  quickbooks_revenue: 0,
                  quickbooks_product_revenue: 0,
                  quickbooks_shipping_revenue: 0,
                  quickbooks_cogs: 0,
                  quickbooks_gross_profit: 0,
                  variance: group.totals.total_pt_paid,
                  variance_percentage: 0,
                };
              }

              const variance = group.totals.total_pt_paid - qbPeriod.revenue;
              const variancePercentage =
                qbPeriod.revenue !== 0
                  ? ((variance / qbPeriod.revenue) * 100)
                  : 0;

              return {
                period: group.period,
                internal_revenue: group.totals.total_pt_paid,
                quickbooks_revenue: qbPeriod.revenue,
                quickbooks_product_revenue: qbPeriod.product_revenue,
                quickbooks_shipping_revenue: qbPeriod.shipping_revenue,
                quickbooks_cogs: qbPeriod.cost_of_goods,
                quickbooks_gross_profit: qbPeriod.gross_profit,
                variance,
                variance_percentage: variancePercentage,
              };
            });
          } else {
            quickbooksData = {
              connected: false,
              location: qbLocation,
              message: `QuickBooks not connected for ${qbLocation}`,
            };
          }
        }
      } catch (error) {
        console.error('Error fetching QuickBooks data:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Provide user-friendly message for rate limiting
        let userMessage = errorMessage;
        if (errorMessage.includes('rate limit')) {
          userMessage = 'QuickBooks API rate limit reached. Data is being fetched with automatic retries. Please wait a moment and the data will appear.';
        }

        quickbooksData = {
          connected: false,
          error: userMessage,
        };
      }
    }

    return NextResponse.json({
      stats,
      dateRange,
      marketers,
      locations,
      periodGroups,
      stateBreakdown: Object.fromEntries(statesByMarketerPeriod),
      chartData,
      granularity,
      quickbooks: quickbooksData,
      quickbooksComparison,
    });
  } catch (error) {
    console.error('Error fetching marketer profitability:', error);
    return NextResponse.json(
      { error: 'Failed to load marketer profitability data' },
      { status: 500 }
    );
  }
}
