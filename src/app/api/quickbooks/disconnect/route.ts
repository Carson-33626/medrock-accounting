/**
 * QuickBooks Disconnect API - Multi-Location
 *
 * Removes QB tokens for a specific location from the database.
 *
 * SECURITY (2026-08-10): gated behind `requireAdmin()` alongside authorize/callback. Dropping a
 * company's tokens breaks every payroll post, allocation pull and account lookup for that entity
 * until someone reconnects, so it is an admin action — not something any accounting-app user
 * should be able to trigger, and not something that should rely on middleware alone
 * (DEV_SKIP_AUTH bypasses middleware wholesale).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { disconnect, LOCATION_MAPPING, type Location } from '@/lib/quickbooks-multi';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const { searchParams } = new URL(request.url);
    const locationParam = searchParams.get('location');

    // Validate location against the configured companies
    if (!locationParam || !(Object.keys(LOCATION_MAPPING) as string[]).includes(locationParam)) {
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
