import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { ensurePath, listChildren, uploadFile } from '@/lib/google/drive';
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
const ALLOWED_MIME = /^(image\/(jpeg|png|heic|heif|webp)|application\/pdf)$/;

export interface UploadResult {
  originalName: string;
  status: 'ok' | 'error';
  fileName?: string;
  fileId?: string;
  removalToken?: string;
  error?: string;
}

function extensionOf(name: string): string {
  const match = /\.[^.]+$/.exec(name);
  return match ? match[0] : '.jpg';
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

    const form = await request.formData();
    const location = String(form.get('location') ?? '').trim();
    const isoDate = String(form.get('date') ?? '').trim();
    const rawType = String(form.get('type') ?? '').trim();
    const rawAmount = String(form.get('amount') ?? '');
    const files = form.getAll('files').filter((f): f is File => f instanceof File);

    if (!location) return NextResponse.json({ error: 'Location is required' }, { status: 400 });
    if (!isDepositType(rawType)) {
      return NextResponse.json({ error: 'Type must be Deposit or Check' }, { status: 400 });
    }
    if (files.length === 0) return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `At most ${MAX_FILES} files per upload` }, { status: 400 });
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
        if (file.size > MAX_FILE_BYTES) throw new Error('File is larger than 25 MB');
        if (!ALLOWED_MIME.test(file.type)) throw new Error(`Unsupported file type: ${file.type || 'unknown'}`);

        const fileName = buildFileName({
          isoDate,
          type,
          amount,
          uploader,
          seq,
          ext: extensionOf(file.name),
        });

        const bytes = Buffer.from(await file.arrayBuffer());
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
        // One bad file must not sink the batch.
        results.push({
          originalName: file.name,
          status: 'error',
          error: error instanceof Error ? error.message : 'Upload failed',
        });
      }
    }

    return NextResponse.json({ results });
  } catch (error: unknown) {
    console.error('[deposits/upload]', error);
    return NextResponse.json({ error: 'Upload failed — the portal could not reach Google Drive' }, { status: 502 });
  }
}
