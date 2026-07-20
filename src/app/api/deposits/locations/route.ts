import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listLocations } from '@/lib/deposits/locations';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/deposits/locations — folder names directly under Deposit Slips,
 * live from Drive rather than hardcoded so it never drifts from reality
 * (spec §7: "options populated live from Drive's existing location folders").
 */
export async function GET() {
  // requireAuth throws NEXT_REDIRECT — must run outside the try so Next handles it.
  await requireAuth();

  try {
    const root = process.env.DEPOSIT_SLIPS_FOLDER_ID;
    if (!root) throw new Error('DEPOSIT_SLIPS_FOLDER_ID is not set');

    const locations = await listLocations(root);

    return NextResponse.json({ locations });
  } catch (error: unknown) {
    console.error('[deposits/locations]', error);
    return NextResponse.json({ error: 'Could not read locations from Drive' }, { status: 502 });
  }
}
