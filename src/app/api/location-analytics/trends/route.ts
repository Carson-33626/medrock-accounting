import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { computeLocationTrends } from '@/lib/location-analytics-trends';
import type { Basis } from '@/types/location-analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const sp = request.nextUrl.searchParams;
    const startDate = sp.get('startDate');
    const endDate = sp.get('endDate');
    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: 'Missing required parameters: startDate, endDate' },
        { status: 400 },
      );
    }
    const basis: Basis = sp.get('basis') === 'Accrual' ? 'Accrual' : 'Cash';

    const data = await computeLocationTrends({ startDate, endDate, basis });
    return NextResponse.json(data);
  } catch (error) {
    console.error('[Location Trends] API error:', error);
    const message = error instanceof Error ? error.message : 'Failed to fetch location trends';
    if (message.includes('rate limit')) {
      return NextResponse.json({ error: message }, { status: 429 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
