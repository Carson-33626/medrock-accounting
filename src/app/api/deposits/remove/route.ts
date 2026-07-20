import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { trashFile } from '@/lib/google/drive';
import { verifyRemovalToken } from '@/lib/deposits/removalToken';
import type { JsonValue } from '@/lib/payroll/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RemoveRequestBody {
  [key: string]: JsonValue;
  fileId: string;
  removalToken: string;
}

function isRemoveRequestBody(body: JsonValue): body is RemoveRequestBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof body.fileId === 'string' &&
    body.fileId.length > 0 &&
    typeof body.removalToken === 'string' &&
    body.removalToken.length > 0
  );
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

  if (!isRemoveRequestBody(body)) {
    return NextResponse.json({ error: 'fileId and removalToken are required' }, { status: 400 });
  }

  const { fileId, removalToken } = body;

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
    return NextResponse.json({ error: 'Could not remove the file' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
