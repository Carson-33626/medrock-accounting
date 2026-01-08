/**
 * QuickBooks Connection Status API - Multi-Location
 *
 * Returns connection status for all locations (FL, TN, TX).
 */

import { NextResponse } from 'next/server';
import { getConnectionStatus, getValidTokens, type Location } from '@/lib/quickbooks-multi';

export async function GET() {
  try {
    const status = await getConnectionStatus();

    // Get detailed info for each connected location
    const details: Record<string, any> = {};

    for (const location of Object.keys(status) as Location[]) {
      if (status[location]) {
        const tokens = await getValidTokens(location);
        details[location] = {
          connected: true,
          realmId: tokens?.realm_id || null,
          companyName: tokens?.company_name || null,
          expiresAt: tokens?.expires_at || null,
        };
      } else {
        details[location] = {
          connected: false,
          realmId: null,
          companyName: null,
          expiresAt: null,
        };
      }
    }

    return NextResponse.json({
      status,
      details,
    });
  } catch (error) {
    console.error('QB status check error:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
