import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { computeLocationForecast } from '@/lib/location-analytics-forecast';
import type { Basis } from '@/types/location-analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const sp = request.nextUrl.searchParams;
    const basis: Basis = sp.get('basis') === 'Accrual' ? 'Accrual' : 'Cash';
    const today = new Date().toISOString().slice(0, 10);

    const data = await computeLocationForecast({ basis, today });
    return NextResponse.json(data);
  } catch (error) {
    console.error('[Location Forecast] API error:', error);
    const message = error instanceof Error ? error.message : 'Failed to fetch location forecast';
    if (message.includes('rate limit')) {
      return NextResponse.json({ error: message }, { status: 429 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
