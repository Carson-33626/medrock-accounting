import { NextRequest, NextResponse } from 'next/server';
import historicalData from '@/data/historical-coupons.json';

interface HistoricalCoupon {
  entryId: string;
  formId: string;
  discountCode: string;
  calculatedDiscount: number | null;
  firstName?: string;
  lastName?: string;
  email?: string;
  dateCreated: string | null;
  paymentAmount?: string;
  totalAmount?: string;
}

interface LiveCoupon {
  _id: string;
  couponCode: string;
  discountAmount: number;
  discountType: string;
  redeemedAt: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  source: string;
}

interface CouponRedemption {
  id: string;
  couponCode: string;
  discountAmount: number;
  redeemedAt: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  source: 'historical' | 'live';
}

// Transform historical data to common format
function transformHistorical(data: HistoricalCoupon[]): CouponRedemption[] {
  return data
    .filter(item => item.dateCreated)
    .map(item => ({
      id: `hist-${item.entryId}`,
      couponCode: item.discountCode,
      discountAmount: item.calculatedDiscount || 10,
      redeemedAt: item.dateCreated!.replace(/"/g, ''),
      firstName: item.firstName,
      lastName: item.lastName,
      email: item.email,
      source: 'historical' as const
    }));
}

// Transform live API data to common format
function transformLive(data: LiveCoupon[]): CouponRedemption[] {
  return data.map(item => ({
    id: `live-${item._id}`,
    couponCode: item.couponCode,
    discountAmount: item.discountAmount,
    redeemedAt: item.redeemedAt,
    firstName: item.firstName,
    lastName: item.lastName,
    email: item.email,
    source: 'live' as const
  }));
}

// Fetch all live data from MedRock Payments API
async function fetchLiveData(): Promise<LiveCoupon[]> {
  const apiUrl = process.env.MEDROCK_PAYMENTS_API_URL;
  const apiUser = process.env.MEDROCK_PAYMENTS_API_USER;
  const apiPass = process.env.MEDROCK_PAYMENTS_API_PASS;

  if (!apiUrl || !apiUser || !apiPass) {
    console.warn('MedRock Payments API credentials not configured');
    return [];
  }

  const allData: LiveCoupon[] = [];
  let page = 1;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    try {
      const response = await fetch(
        `${apiUrl}/coupons/admin/redeemed?page=${page}&limit=${limit}`,
        {
          headers: {
            'Authorization': 'Basic ' + Buffer.from(`${apiUser}:${apiPass}`).toString('base64')
          },
          cache: 'no-store'
        }
      );

      if (!response.ok) {
        console.error(`API error: ${response.status}`);
        break;
      }

      const result = await response.json();
      allData.push(...result.data);

      hasMore = page < result.totalPages;
      page++;

      // Safety limit - don't fetch more than 50 pages (5000 records)
      if (page > 50) break;
    } catch (error) {
      console.error('Error fetching live data:', error);
      break;
    }
  }

  return allData;
}

// Filter redemptions based on query parameters
function filterRedemptions(
  data: CouponRedemption[],
  filters: {
    startDate?: string;
    endDate?: string;
    source?: string;
    couponCode?: string;
  }
): CouponRedemption[] {
  return data.filter(item => {
    // Date filtering
    if (filters.startDate) {
      const itemDate = item.redeemedAt.substring(0, 10);
      if (itemDate < filters.startDate) return false;
    }
    if (filters.endDate) {
      const itemDate = item.redeemedAt.substring(0, 10);
      if (itemDate > filters.endDate) return false;
    }

    // Source filtering
    if (filters.source && filters.source !== 'all') {
      if (item.source !== filters.source) return false;
    }

    // Coupon code filtering (case-insensitive exact match)
    if (filters.couponCode) {
      if (item.couponCode.toUpperCase() !== filters.couponCode.toUpperCase()) {
        return false;
      }
    }

    return true;
  });
}

// Get the period key based on granularity
function getPeriodKey(dateStr: string, granularity: string): string {
  const date = dateStr.substring(0, 10); // YYYY-MM-DD
  switch (granularity) {
    case 'yearly':
      return date.substring(0, 4); // YYYY
    case 'quarterly': {
      const year = date.substring(0, 4);
      const month = parseInt(date.substring(5, 7));
      const quarter = Math.ceil(month / 3);
      return `${year}-Q${quarter}`;
    }
    case 'daily':
      return date; // YYYY-MM-DD
    case 'monthly':
    default:
      return date.substring(0, 7); // YYYY-MM
  }
}

// Aggregate data by time period for the line graph
function aggregateByPeriod(data: CouponRedemption[], granularity: string) {
  const byPeriod = new Map<string, { count: number; discount: number }>();

  data.forEach(item => {
    if (!item.redeemedAt) return;
    const periodKey = getPeriodKey(item.redeemedAt, granularity);
    const existing = byPeriod.get(periodKey) || { count: 0, discount: 0 };
    existing.count++;
    existing.discount += item.discountAmount;
    byPeriod.set(periodKey, existing);
  });

  return [...byPeriod.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, data]) => ({
      period,
      redemptions: data.count,
      discountValue: Math.round(data.discount * 100) / 100
    }));
}

// Get top coupons
function getTopCoupons(data: CouponRedemption[]) {
  const byCoupon = new Map<string, { count: number; discount: number }>();

  data.forEach(item => {
    const code = item.couponCode.toUpperCase(); // Normalize case
    const existing = byCoupon.get(code) || { count: 0, discount: 0 };
    existing.count++;
    existing.discount += item.discountAmount;
    byCoupon.set(code, existing);
  });

  return [...byCoupon.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([code, data]) => ({
      code,
      count: data.count,
      totalDiscount: Math.round(data.discount * 100) / 100
    }));
}

export async function GET(request: NextRequest) {
  try {
    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const filters = {
      startDate: searchParams.get('startDate') || undefined,
      endDate: searchParams.get('endDate') || undefined,
      source: searchParams.get('source') || undefined,
      couponCode: searchParams.get('couponCode') || undefined
    };
    const granularity = searchParams.get('granularity') || 'monthly';
    const isExport = searchParams.get('export') === 'true';

    // Fetch live data from API
    const liveData = await fetchLiveData();
    const liveRedemptions = transformLive(liveData);

    // Transform historical data
    const historicalRedemptions = transformHistorical(historicalData as HistoricalCoupon[]);

    // Merge both datasets
    let allRedemptions = [...historicalRedemptions, ...liveRedemptions];

    // Store original counts for source breakdown
    const originalSourceBreakdown = {
      historical: historicalRedemptions.length,
      live: liveRedemptions.length
    };

    // Apply filters
    allRedemptions = filterRedemptions(allRedemptions, filters);

    // Calculate stats on filtered data
    const totalRedemptions = allRedemptions.length;
    const totalDiscount = allRedemptions.reduce((sum, r) => sum + r.discountAmount, 0);
    const uniqueCoupons = new Set(allRedemptions.map(r => r.couponCode.toUpperCase())).size;

    // Get time period data for line graph
    const periodData = aggregateByPeriod(allRedemptions, granularity);

    // Get top coupons
    const topCoupons = getTopCoupons(allRedemptions);

    // Date range from filtered data
    const sortedByDate = [...allRedemptions].sort((a, b) =>
      (a.redeemedAt || '').localeCompare(b.redeemedAt || '')
    );
    const dateRange = {
      earliest: sortedByDate[0]?.redeemedAt,
      latest: sortedByDate[sortedByDate.length - 1]?.redeemedAt
    };

    // Filtered source breakdown
    const filteredSourceBreakdown = {
      historical: allRedemptions.filter(r => r.source === 'historical').length,
      live: allRedemptions.filter(r => r.source === 'live').length
    };

    // Get coupon codes that have been used at least 2 times (filters out typos/test data)
    const couponCounts = new Map<string, number>();
    [...historicalRedemptions, ...liveRedemptions].forEach(r => {
      const code = r.couponCode.toUpperCase().trim();
      couponCounts.set(code, (couponCounts.get(code) || 0) + 1);
    });

    const allCouponCodes = [...couponCounts.entries()]
      .filter(([, count]) => count >= 2) // Only codes used 2+ times
      .map(([code]) => code)
      .sort();

    return NextResponse.json({
      stats: {
        totalRedemptions,
        totalDiscount: Math.round(totalDiscount * 100) / 100,
        uniqueCoupons,
        avgDiscount: totalRedemptions > 0 ? Math.round((totalDiscount / totalRedemptions) * 100) / 100 : 0
      },
      dateRange,
      sourceBreakdown: filteredSourceBreakdown,
      originalSourceBreakdown,
      periodData,
      granularity,
      topCoupons,
      allCouponCodes,
      redemptions: isExport ? sortedByDate : sortedByDate.slice(-100).reverse() // All for export, recent 100 otherwise
    });
  } catch (error) {
    console.error('Error loading coupon data:', error);
    return NextResponse.json(
      { error: 'Failed to load coupon data' },
      { status: 500 }
    );
  }
}
