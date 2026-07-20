import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { trashFile } from '@/lib/google/drive';
import { verifyRemovalToken } from '@/lib/deposits/removalToken';
import type { JsonValue } from '@/lib/payroll/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function parseRemoveRequest(body: JsonValue): { fileId: string; removalToken: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { fileId, removalToken } = body;
  if (typeof fileId !== 'string' || fileId.length === 0) return null;
  if (typeof removalToken !== 'string' || removalToken.length === 0) return null;
  return { fileId, removalToken };
}

/**
 * Scoped undo (spec §9.1). Trashes a file the caller uploaded moments ago.
 *
 * This route is deliberately exempt from the accounting entitlement check —
 * any authenticated MedRock employee can reach it — so the removal token is
 * the ONLY authorization here; there is no second gate behind it. The
 * service account can write across the entire Deposit Slips tree (five
 * years of real accounting records), so a bare client-supplied fileId must
 * never be trusted. verifyRemovalToken re-derives the HMAC from the
 * *session's* user id and the exact file id, and verification must fail
 * closed — 403, with zero Drive interaction — before trashFile is ever
 * called. Never add a fallback path that skips that check.
 */
export async function POST(request: NextRequest) {
  // requireAuth throws NEXT_REDIRECT — must run outside the try so Next handles it.
  const user = await requireAuth();

  let body: JsonValue;
  try {
    body = (await request.json()) as JsonValue;
  } catch (error: unknown) {
    console.error('[deposits/remove] malformed body', error);
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 });
  }

  const parsed = parseRemoveRequest(body);
  if (!parsed) {
    return NextResponse.json({ error: 'fileId and removalToken are required' }, { status: 400 });
  }

  const { fileId, removalToken } = parsed;

  // Pre-check the secret so a missing env var never reaches
  // verifyRemovalToken's throw — that throw is unhandled here (outside any
  // try) and would surface as an unlogged 500 that, in dev builds, names the
  // env var. Fail closed the same way the rest of this route does: a fixed
  // 502 message, logged server-side, zero Drive interaction. Mirrors the
  // check in src/app/api/deposits/upload/route.ts.
  if (!process.env.DEPOSIT_REMOVE_SECRET) {
    console.error('[deposits/remove] DEPOSIT_REMOVE_SECRET is not set');
    return NextResponse.json({ error: 'Could not remove the file' }, { status: 502 });
  }

  // Verification happens before any Drive call, and a failure here returns
  // 403 with no Drive interaction at all — the token is the only gate.
  if (!verifyRemovalToken(removalToken, fileId, user.id)) {
    return NextResponse.json(
      { error: 'This file can no longer be removed from the portal' },
      { status: 403 }
    );
  }

  try {
    await trashFile(fileId);
  } catch (error: unknown) {
    // Drive errors can carry file/folder ids and the service-account
    // identity — never forward error.message to the client.
    console.error('[deposits/remove]', error);

    // A 404 means the file is already gone (e.g. previously emptied from
    // trash) — from the caller's point of view that's the same outcome as a
    // successful removal, not an upstream failure.
    if (error instanceof Error && error.message.startsWith('Drive API 404:')) {
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Could not remove the file' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
