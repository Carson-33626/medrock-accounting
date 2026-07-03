import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildApWeeklyReport } from '@/lib/ap-weekly';
import { LOCATION_MAPPING, type Location } from '@/lib/quickbooks-multi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  // requireAuth redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  // Standard access (any authenticated user), not admin-gated — report is read-only.
  await requireAuth();

  try {
    const sp = request.nextUrl.searchParams;
    const locationParam = sp.get('location');
    if (!locationParam || !(locationParam in LOCATION_MAPPING)) {
      return NextResponse.json(
        { error: `Missing or invalid location. Expected one of: ${Object.keys(LOCATION_MAPPING).join(', ')}` },
        { status: 400 },
      );
    }
    const location = locationParam as Location;

    const reportDate = sp.get('reportDate') ?? new Date().toISOString().slice(0, 10);
    if (!ISO_DATE_RE.test(reportDate)) {
      return NextResponse.json({ error: 'reportDate must be YYYY-MM-DD' }, { status: 400 });
    }

    const report = await buildApWeeklyReport(location, reportDate);
    return NextResponse.json(report);
  } catch (error) {
    console.error('[AP Weekly] API error:', error);
    const message = error instanceof Error ? error.message : 'Failed to build AP weekly report';
    if (message.includes('rate limit')) {
      return NextResponse.json({ error: message }, { status: 429 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
