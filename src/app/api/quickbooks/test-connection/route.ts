import { NextRequest, NextResponse } from 'next/server';
import { getValidTokens } from '@/lib/quickbooks-multi';
import type { Location } from '@/lib/quickbooks-multi';

const QUICKBOOKS_API_URL = process.env.QUICKBOOKS_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const location = searchParams.get('location') as Location | null;

    if (!location) {
      return NextResponse.json(
        { error: 'Location parameter is required' },
        { status: 400 }
      );
    }

    // Get valid tokens (will refresh if needed)
    const tokens = await getValidTokens(location);

    if (!tokens) {
      return NextResponse.json(
        { error: 'No connection found for this location' },
        { status: 404 }
      );
    }

    // Make a simple API call to QuickBooks to test the connection
    // Using CompanyInfo endpoint which is lightweight
    const response = await fetch(
      `${QUICKBOOKS_API_URL}/v3/company/${tokens.realm_id}/companyinfo/${tokens.realm_id}`,
      {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('QuickBooks API error:', error);

      return NextResponse.json(
        {
          error: 'Connection test failed. Please try reconnecting.',
          details: response.statusText
        },
        { status: response.status }
      );
    }

    const data = await response.json();

    return NextResponse.json({
      success: true,
      companyName: data.CompanyInfo?.CompanyName,
      message: 'Connection is working',
    });

  } catch (error) {
    console.error('Test connection error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to test connection' },
      { status: 500 }
    );
  }
}
