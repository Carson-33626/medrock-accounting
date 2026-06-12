import { NextRequest, NextResponse } from 'next/server';
import { syncQbLinks, QB_LOCATIONS } from '@/lib/qb-links';
import type { Location } from '@/lib/quickbooks-multi';
import type { QbSyncResult } from '@/types/qb-links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// QBO fetch (bills + purchases + payments) + matching can take a while.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const locParam = searchParams.get('location');

  const locations: Location[] =
    locParam && locParam !== 'all'
      ? QB_LOCATIONS.filter((l) => l === locParam)
      : QB_LOCATIONS;
  if (locations.length === 0) {
    return NextResponse.json({ error: `Unknown location: ${locParam}` }, { status: 400 });
  }

  const results: QbSyncResult[] = [];
  const errors: Record<string, string> = {};
  for (const location of locations) {
    try {
      results.push(await syncQbLinks(location));
    } catch (err) {
      // Most likely cause: QB connection needs re-authorization (e.g. FL invalid_grant).
      errors[location] = err instanceof Error ? err.message : 'sync failed';
    }
  }

  const status = results.length === 0 && Object.keys(errors).length > 0 ? 502 : 200;
  return NextResponse.json({ results, errors }, { status });
}
