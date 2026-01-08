/**
 * QuickBooks Revenue API - Multi-Location
 *
 * Fetches revenue data from QuickBooks Online for comparison with internal data.
 * Returns revenue grouped by period (monthly/quarterly/yearly) for a specific location.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRevenueByPeriod, isConnected, type Location } from '@/lib/quickbooks-multi';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Parse query parameters
    const location = searchParams.get('location') as Location | null;
    const startDate = searchParams.get('startDate'); // YYYY-MM-DD
    const endDate = searchParams.get('endDate'); // YYYY-MM-DD
    const granularity = (searchParams.get('granularity') || 'monthly') as
      | 'monthly'
      | 'quarterly'
      | 'yearly';

    // Validate required params
    if (!location || !startDate || !endDate) {
      return NextResponse.json(
        { error: 'location, startDate, and endDate are required' },
        { status: 400 }
      );
    }

    // Validate location
    if (!['MedRock FL', 'MedRock TN', 'MedRock TX'].includes(location)) {
      return NextResponse.json(
        { error: 'Invalid location. Must be "MedRock FL", "MedRock TN", or "MedRock TX"' },
        { status: 400 }
      );
    }

    // Check if QB is connected for this location
    const connected = await isConnected(location);
    if (!connected) {
      return NextResponse.json(
        { error: `QuickBooks not connected for ${location}. Please authorize first.` },
        { status: 401 }
      );
    }

    // Fetch revenue data from QuickBooks
    const revenueData = await getRevenueByPeriod({
      location,
      startDate,
      endDate,
      granularity,
    });

    // Calculate totals
    const totals = {
      revenue: revenueData.reduce((sum, item) => sum + item.revenue, 0),
      cost_of_goods: revenueData.reduce((sum, item) => sum + item.cost_of_goods, 0),
      gross_profit: revenueData.reduce((sum, item) => sum + item.gross_profit, 0),
    };

    return NextResponse.json({
      success: true,
      location,
      data: revenueData,
      totals,
      granularity,
      dateRange: {
        start: startDate,
        end: endDate,
      },
    });
  } catch (error) {
    console.error('QuickBooks revenue API error:', error);

    const errorMessage =
      error instanceof Error ? error.message : 'Failed to fetch QuickBooks revenue';

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
