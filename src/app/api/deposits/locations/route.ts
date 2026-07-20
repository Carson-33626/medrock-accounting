import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listChildren } from '@/lib/google/drive';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Year folders are the pre-migration structure; they are not locations.
const NOT_A_LOCATION = /^(?:\d{4}|__.*)$/;

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

    const children = await listChildren(root);
    const locations = children
      .filter((f) => f.mimeType === FOLDER_MIME && !NOT_A_LOCATION.test(f.name))
      .map((f) => f.name)
      .sort();

    return NextResponse.json({ locations });
  } catch (error: unknown) {
    console.error('[deposits/locations]', error);
    return NextResponse.json({ error: 'Could not read locations from Drive' }, { status: 502 });
  }
}
