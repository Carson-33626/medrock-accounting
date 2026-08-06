/**
 * QuickBooks Disconnect API - Multi-Location
 *
 * Removes QB tokens for a specific location from the database.
 */

import { NextRequest, NextResponse } from 'next/server';
import { disconnect, LOCATION_MAPPING, type Location } from '@/lib/quickbooks-multi';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const locationParam = searchParams.get('location');

    // Validate location against the configured companies
    if (!locationParam || !(locationParam in LOCATION_MAPPING)) {
      return NextResponse.json(
        { error: `Invalid location. Expected one of: ${Object.keys(LOCATION_MAPPING).join(', ')}` },
        { status: 400 }
      );
    }
    const location = locationParam as Location;

    // Delete tokens from database
    await disconnect(location);

    console.log(`QuickBooks disconnected for ${location}`);

    return NextResponse.json({
      success: true,
      location,
      message: `QuickBooks disconnected for ${location}`,
    });
  } catch (error) {
    console.error('QB disconnect error:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to disconnect QuickBooks',
      },
      { status: 500 }
    );
  }
}
