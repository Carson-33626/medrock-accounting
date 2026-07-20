import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { ensurePath, listChildren, uploadFile } from '@/lib/google/drive';
import { listLocations } from '@/lib/deposits/locations';
import { signRemovalToken } from '@/lib/deposits/removalToken';
import {
  buildFolderSegments,
  buildFileName,
  formatAmount,
  formatUploader,
  nextSequence,
  InvalidAmountError,
  type DepositType,
} from '@/lib/deposits/naming';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — phone photos land well under this
const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024; // whole-request ceiling
const ALLOWED_MIME = /^(image\/(jpeg|png|heic|heif|webp)|application\/pdf)$/;

export interface UploadResult {
  originalName: string;
  status: 'ok' | 'error';
  fileName?: string;
  fileId?: string;
  removalToken?: string;
  error?: string;
}

// Extension is derived from the validated MIME type, never the client-supplied
// filename — an unbounded, unfiltered `extensionOf(name)` let a filename like
// `evil.jpg/../../../etc/passwd` land arbitrary bytes in the stored name.
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

function extensionForMime(mimeType: string): string {
  return EXT_BY_MIME[mimeType] ?? '.jpg';
}

// Per-file failure categories. `file.type` and `file.size` are client-supplied
// and trivially forged, and Drive/Google errors carry file/folder ids and the
// service-account identity — none of that may reach the client. The route's
// catch below maps each of these to a fixed, safe string and logs the real
// error server-side.
class OversizeFileError extends Error {}
class UnsupportedTypeError extends Error {}
class ContentMismatchError extends Error {}

/**
 * Checks the leading "magic bytes" of a file against its declared (and
 * already ALLOWED_MIME-validated) MIME type. `file.type` is client-supplied
 * and trivially forged; this is a cheap, in-memory check against bytes we
 * already have.
 */
function matchesMagicBytes(mimeType: string, bytes: Buffer): boolean {
  switch (mimeType) {
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case 'application/pdf':
      return (
        bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
      );
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    case 'image/heic':
    case 'image/heif':
      // The brand at bytes 8-11 varies (heic, heix, mif1, msf1, ...) — only
      // the `ftyp` box tag at offset 4 is stable across HEIC/HEIF variants.
      return (
        bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
      );
    default:
      return false;
  }
}

// Type guard rather than an `as DepositType` assertion — matches the
// `isEntity(value): value is Entity` convention already used across the
// payroll routes (e.g. src/app/api/payroll/dimensions/route.ts) for turning
// a raw form-data `string` into a validated literal union.
function isDepositType(value: string): value is DepositType {
  return value === 'Deposit' || value === 'Check';
}

/**
 * POST /api/deposits/upload — multipart form (location, date, type, amount?,
 * files[]) -> one Drive folder path, one filename convention per file.
 *
 * Per-file try/catch: one bad file (oversize, wrong mime, Drive hiccup) must
 * not sink the rest of the batch. Sequence numbers are read from the folder
 * once up front and incremented only on a successful upload, because each
 * filename depends on the previous file actually having landed.
 */
export async function POST(request: NextRequest) {
  // requireAuth throws NEXT_REDIRECT — must run outside the try so Next handles it.
  const user = await requireAuth();

  try {
    const root = process.env.DEPOSIT_SLIPS_FOLDER_ID;
    if (!root) throw new Error('DEPOSIT_SLIPS_FOLDER_ID is not set');

    // Fail fast if removal-token signing can't work, BEFORE any file is
    // uploaded — otherwise a missing secret orphans an already-uploaded file
    // that gets reported to the user as a plain error with no removal token.
    if (!process.env.DEPOSIT_REMOVE_SECRET) {
      throw new Error('DEPOSIT_REMOVE_SECRET is not set');
    }

    // `request.formData()` buffers the entire multipart body into memory
    // before any other validation runs, so this ceiling must be checked
    // first. Content-Length can be absent or lied about by the client, so
    // this is a best-effort early rejection — the actual-bytes check below,
    // after parsing, is the one that can't be bypassed.
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { error: 'Upload is too large — send fewer photos at a time' },
        { status: 413 }
      );
    }

    const form = await request.formData();
    const location = String(form.get('location') ?? '').trim();
    const isoDate = String(form.get('date') ?? '').trim();
    const rawType = String(form.get('type') ?? '').trim();
    const rawAmount = String(form.get('amount') ?? '');
    const files = form.getAll('files').filter((f): f is File => f instanceof File);

    if (!location) return NextResponse.json({ error: 'Location is required' }, { status: 400 });

    // `location` flows into ensurePath, which CREATES any missing folder
    // segment — so it must be checked against the real, existing location
    // folders (not lowercased or fuzzy-matched) before it is used for
    // anything, or an employee can write into the legacy year folders (e.g.
    // `location=2021`) or create arbitrary folder trees under the root.
    const validLocations = await listLocations(root);
    if (!validLocations.includes(location)) {
      return NextResponse.json({ error: 'Unknown location' }, { status: 400 });
    }

    if (!isDepositType(rawType)) {
      return NextResponse.json({ error: 'Type must be Deposit or Check' }, { status: 400 });
    }
    if (files.length === 0) return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `At most ${MAX_FILES} files per upload` }, { status: 400 });
    }

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { error: 'Upload is too large — send fewer photos at a time' },
        { status: 413 }
      );
    }

    const type: DepositType = rawType;

    let amount: string | null;
    try {
      amount = formatAmount(rawAmount);
    } catch (error: unknown) {
      if (error instanceof InvalidAmountError) {
        return NextResponse.json({ error: 'Amount is not a valid dollar figure' }, { status: 400 });
      }
      throw error;
    }

    let segments: string[];
    try {
      segments = buildFolderSegments(location, isoDate);
    } catch {
      return NextResponse.json({ error: 'Date must be a valid calendar date' }, { status: 400 });
    }

    const folderId = await ensurePath(root, segments);
    const existing = await listChildren(folderId);
    let seq = nextSequence(existing.map((f) => f.name));

    const uploader = formatUploader({
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
    });

    const results: UploadResult[] = [];

    // Sequential: each file's sequence number depends on the previous one.
    for (const file of files) {
      try {
        if (file.size > MAX_FILE_BYTES) throw new OversizeFileError('File is larger than 25 MB');
        if (!ALLOWED_MIME.test(file.type)) {
          throw new UnsupportedTypeError(`Unsupported file type: ${file.type || 'unknown'}`);
        }

        const bytes = Buffer.from(await file.arrayBuffer());

        if (!matchesMagicBytes(file.type, bytes)) {
          throw new ContentMismatchError('File content does not match its declared type');
        }

        const fileName = buildFileName({
          isoDate,
          type,
          amount,
          uploader,
          seq,
          ext: extensionForMime(file.type),
        });

        const uploaded = await uploadFile(folderId, fileName, file.type, bytes);

        results.push({
          originalName: file.name,
          status: 'ok',
          fileName: uploaded.name,
          fileId: uploaded.id,
          // The token is the ONLY authorization the remove route has later —
          // it must be bound to the uploading user's id, not the file alone.
          removalToken: signRemovalToken(uploaded.id, user.id),
        });
        seq += 1;
      } catch (error: unknown) {
        // One bad file must not sink the batch. The real error (which may be
        // a raw Drive API error carrying file/folder ids and the
        // service-account identity, or an env-var name) is logged
        // server-side only; the client gets one of a small set of safe,
        // fixed strings.
        console.error('[deposits/upload] file failed', file.name, error);

        let message = 'Upload failed';
        if (error instanceof OversizeFileError) message = 'File is larger than 25 MB';
        else if (error instanceof UnsupportedTypeError) message = 'Unsupported file type';
        else if (error instanceof ContentMismatchError) message = 'File content does not match its type';

        results.push({
          originalName: file.name,
          status: 'error',
          error: message,
        });
      }
    }

    return NextResponse.json({ results });
  } catch (error: unknown) {
    console.error('[deposits/upload]', error);
    return NextResponse.json({ error: 'Upload failed — the portal could not reach Google Drive' }, { status: 502 });
  }
}
