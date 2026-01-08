/**
 * QuickBooks Disconnect API - Multi-Location
 *
 * Removes QB tokens for a specific location from the database.
 */

import { NextRequest, NextResponse } from 'next/server';
import { disconnect, type Location } from '@/lib/quickbooks-multi';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const location = searchParams.get('location') as Location | null;

    // Validate location
    if (!location || !['MedRock FL', 'MedRock TN', 'MedRock TX'].includes(location)) {
      return NextResponse.json(
        { error: 'Invalid location. Must be "MedRock FL", "MedRock TN", or "MedRock TX"' },
        { status: 400 }
      );
    }

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
