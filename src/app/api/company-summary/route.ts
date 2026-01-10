import { NextRequest, NextResponse } from 'next/server';
import { getCompanyFinancials, getConnectedLocations, type Location } from '@/lib/quickbooks-multi';
import { requireAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CompanyFinancials {
  location: string;
  period: string;
  revenue: number;
  product_revenue: number;
  shipping_revenue: number;
  cogs: number;
  gross_profit: number;
  gross_margin_percent: number;
  payroll_total: number;
  operating_expenses_total: number;
  net_income: number;
  net_margin_percent: number;
  accounting_method: 'Cash' | 'Accrual';
  cached: boolean;
}

export async function GET(request: NextRequest) {
  try {
    // Require admin access
    await requireAdmin();

    const searchParams = request.nextUrl.searchParams;
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const accountingMethod = (searchParams.get('accountingMethod') || 'Cash') as 'Cash' | 'Accrual';

    // Validate required parameters
    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: 'Missing required parameters: startDate, endDate' },
        { status: 400 }
      );
    }

    // Get all connected locations
    const connectedLocations = await getConnectedLocations();

    if (connectedLocations.length === 0) {
      return NextResponse.json(
        {
          locations: [],
          totals: {
            location: 'TOTAL',
            period: `${startDate} to ${endDate}`,
            revenue: 0,
            product_revenue: 0,
            shipping_revenue: 0,
            cogs: 0,
            gross_profit: 0,
            gross_margin_percent: 0,
            payroll_total: 0,
            operating_expenses_total: 0,
            net_income: 0,
            net_margin_percent: 0,
            accounting_method: accountingMethod,
            cached: false,
          },
          period: `${startDate} to ${endDate}`,
          accounting_method: accountingMethod,
          message: 'No QuickBooks locations connected. Please connect locations in Admin > QuickBooks.',
        },
        { status: 200 }
      );
    }

    console.log(`[Company Summary] Fetching data for ${connectedLocations.length} locations...`);

    // Fetch financials for each location sequentially (to avoid rate limiting)
    const locationData: CompanyFinancials[] = [];

    for (const location of connectedLocations) {
      try {
        console.log(`[Company Summary] Fetching ${location}...`);

        const financials = await getCompanyFinancials({
          location,
          startDate,
          endDate,
          accounting_method: accountingMethod,
        });

        locationData.push(financials);

        console.log(`[Company Summary] ✓ ${location}: Revenue $${financials.revenue.toLocaleString()}, Net Income $${financials.net_income.toLocaleString()}`);
      } catch (error) {
        console.error(`[Company Summary] Error fetching ${location}:`, error);
        // Continue with other locations
      }
    }

    // Calculate totals across all locations
    const totals: CompanyFinancials = {
      location: 'TOTAL',
      period: `${startDate} to ${endDate}`,
      revenue: 0,
      product_revenue: 0,
      shipping_revenue: 0,
      cogs: 0,
      gross_profit: 0,
      gross_margin_percent: 0,
      payroll_total: 0,
      operating_expenses_total: 0,
      net_income: 0,
      net_margin_percent: 0,
      accounting_method: accountingMethod,
      cached: false,
    };

    locationData.forEach(loc => {
      totals.revenue += loc.revenue;
      totals.product_revenue += loc.product_revenue;
      totals.shipping_revenue += loc.shipping_revenue;
      totals.cogs += loc.cogs;
      totals.gross_profit += loc.gross_profit;
      totals.payroll_total += loc.payroll_total;
      totals.operating_expenses_total += loc.operating_expenses_total;
      totals.net_income += loc.net_income;
    });

    // Recalculate percentages for totals
    totals.gross_margin_percent = totals.revenue > 0 ? (totals.gross_profit / totals.revenue) * 100 : 0;
    totals.net_margin_percent = totals.revenue > 0 ? (totals.net_income / totals.revenue) * 100 : 0;

    console.log(`[Company Summary] ✓ TOTAL: Revenue $${totals.revenue.toLocaleString()}, Net Income $${totals.net_income.toLocaleString()}`);

    return NextResponse.json({
      locations: locationData,
      totals,
      period: `${startDate} to ${endDate}`,
      accounting_method: accountingMethod,
    });
  } catch (error: any) {
    console.error('[Company Summary] API Error:', error);

    // Check for specific error types
    if (error.message?.includes('not connected')) {
      return NextResponse.json(
        { error: 'QuickBooks not connected. Please connect in Admin > QuickBooks.' },
        { status: 503 }
      );
    }

    if (error.message?.includes('rate limit')) {
      return NextResponse.json(
        { error: 'QuickBooks API rate limit exceeded. Please try again in a moment.' },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: error.message || 'Failed to fetch company summary' },
      { status: 500 }
    );
  }
}
