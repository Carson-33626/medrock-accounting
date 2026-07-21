import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { validateManualForecastInput } from '@/lib/forecast/manual-forecast-validate';
import { createManualForecast, listManualForecasts } from '@/lib/forecast/manual-forecast-repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** True when `error` is a node-postgres error carrying a SQLSTATE `code`. */
function isPgError(error: unknown): error is { code: string; message?: string } {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof (error as { code: unknown }).code === 'string';
}

/** GET /api/location-analytics/manual-forecast — list all manual forecasts. */
export async function GET() {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const data = await listManualForecasts();
    return NextResponse.json(data);
  } catch (error) {
    console.error('[manual-forecast GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to list manual forecasts';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST /api/location-analytics/manual-forecast — create a manual forecast. */
export async function POST(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  const admin = await requireAdmin();

  try {
    const body: unknown = await request.json();
    const result = validateManualForecastInput(body);
    if (!result.ok) {
      return NextResponse.json({ errors: result.errors }, { status: 400 });
    }

    const created = await createManualForecast(result.value, admin.email);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (isPgError(error) && error.code === '23505') {
      return NextResponse.json(
        { error: 'A manual forecast with this name already exists' },
        { status: 409 },
      );
    }
    console.error('[manual-forecast POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to create manual forecast';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
