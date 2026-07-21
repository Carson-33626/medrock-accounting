import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { ALLOWED_MIME, MAX_FILE_BYTES, matchesMagicBytes } from '@/lib/deposits/fileValidation';
import { runOcr } from '@/lib/deposits/ocrClient';
import { EMPTY_SUGGESTIONS, extractDepositFields } from '@/lib/deposits/extractDepositFields';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The gateway base64-encodes the payload (~+33%) against API Gateway's request
// cap, so keep the raw file well under it. Phone photos are 1–4 MB; anything
// bigger just falls back to manual entry rather than erroring.
const MAX_OCR_BYTES = 6 * 1024 * 1024;

/**
 * POST /api/deposits/ocr — multipart { file } -> { suggestions }.
 *
 * Read-only: reads one image, asks the OCR gateway, returns suggested
 * date/type/amount. Writes nothing. OCR is best-effort — EVERY failure path
 * returns EMPTY_SUGGESTIONS (HTTP 200) so the client silently falls back to
 * manual entry. Raw upstream errors are logged server-side only.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // requireAuth throws NEXT_REDIRECT — must run outside the try.
  await requireAuth();

  try {
    const form = await request.formData();
    const file = form.getAll('file').find((f): f is File => f instanceof File);

    if (!file) return NextResponse.json({ suggestions: EMPTY_SUGGESTIONS });
    if (file.size > MAX_FILE_BYTES || file.size > MAX_OCR_BYTES) {
      return NextResponse.json({ suggestions: EMPTY_SUGGESTIONS });
    }
    if (!ALLOWED_MIME.test(file.type)) {
      return NextResponse.json({ suggestions: EMPTY_SUGGESTIONS });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (!matchesMagicBytes(file.type, bytes)) {
      return NextResponse.json({ suggestions: EMPTY_SUGGESTIONS });
    }

    const ocr = await runOcr(bytes);
    const suggestions = extractDepositFields(ocr);
    return NextResponse.json({ suggestions });
  } catch (error: unknown) {
    // Best-effort: never fail the client. The real error (which may carry the
    // gateway URL/status or an env-var name) is logged server-side only.
    console.error('[deposits/ocr]', error);
    return NextResponse.json({ suggestions: EMPTY_SUGGESTIONS });
  }
}
