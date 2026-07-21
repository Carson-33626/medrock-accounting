import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { validateManualForecastInput } from '@/lib/forecast/manual-forecast-validate';
import {
  deleteManualForecast,
  getManualForecast,
  updateManualForecast,
} from '@/lib/forecast/manual-forecast-repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** True when `error` is a node-postgres error carrying a SQLSTATE `code`. */
function isPgError(error: unknown): error is { code: string; message?: string } {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof (error as { code: unknown }).code === 'string';
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

/** GET /api/location-analytics/manual-forecast/[id] — load one manual forecast. */
export async function GET(_request: NextRequest, context: RouteContext) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const { id } = await context.params;
    const forecastId = parseId(id);
    if (forecastId === null) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }

    const found = await getManualForecast(forecastId);
    if (!found) {
      return NextResponse.json({ error: 'manual forecast not found' }, { status: 404 });
    }

    return NextResponse.json(found);
  } catch (error) {
    console.error('[manual-forecast/[id] GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load manual forecast';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** PUT /api/location-analytics/manual-forecast/[id] — replace a manual forecast. */
export async function PUT(request: NextRequest, context: RouteContext) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const { id } = await context.params;
    const forecastId = parseId(id);
    if (forecastId === null) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }

    const body: unknown = await request.json();
    const result = validateManualForecastInput(body);
    if (!result.ok) {
      return NextResponse.json({ errors: result.errors }, { status: 400 });
    }

    const updated = await updateManualForecast(forecastId, result.value);
    if (!updated) {
      return NextResponse.json({ error: 'manual forecast not found' }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    if (isPgError(error) && error.code === '23505') {
      return NextResponse.json(
        { error: 'A manual forecast with this name already exists' },
        { status: 409 },
      );
    }
    console.error('[manual-forecast/[id] PUT]', error);
    const message = error instanceof Error ? error.message : 'Failed to update manual forecast';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/location-analytics/manual-forecast/[id] — remove a manual forecast. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const { id } = await context.params;
    const forecastId = parseId(id);
    if (forecastId === null) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }

    const deleted = await deleteManualForecast(forecastId);
    if (!deleted) {
      return NextResponse.json({ error: 'manual forecast not found' }, { status: 404 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error('[manual-forecast/[id] DELETE]', error);
    const message = error instanceof Error ? error.message : 'Failed to delete manual forecast';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
