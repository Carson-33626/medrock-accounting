import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listChildrenWithLinks, type DriveFileWithLink } from '@/lib/google/drive';
import { NOT_A_LOCATION } from '@/lib/deposits/locations';
import { parsePortalName, parseLegacyName, type DepositType } from '@/lib/deposits/naming';
import { buildSummary, type DepositRecord } from '@/lib/deposits/summary';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

interface ResolvedFields {
  isoDate: string | null;
  type: DepositType | null;
  amount: string | null;
  uploader: string | null;
}

/**
 * Parses a filename with `parsePortalName`, falling back to `parseLegacyName`,
 * and falling back to the containing date folder's name for the date only —
 * see spec §5.1/§6. A file matching neither convention still comes back with
 * (at minimum) the folder-derived date; it is never dropped.
 */
function resolveFields(fileName: string, folderIsoDate: string | null): ResolvedFields {
  const portal = parsePortalName(fileName);
  if (portal.isoDate) return portal;

  const legacy = parseLegacyName(fileName);
  return {
    isoDate: legacy.isoDate ?? folderIsoDate,
    type: legacy.type,
    amount: legacy.amount,
    // Legacy uploader is unrecoverable by design — see naming.ts FileNameParts.
    uploader: null,
  };
}

async function collectDateFolderRecords(
  locationName: string,
  dateFolder: DriveFileWithLink
): Promise<DepositRecord[]> {
  const folderIsoDate = DATE_FOLDER.test(dateFolder.name) ? dateFolder.name : null;
  const children = await listChildrenWithLinks(dateFolder.id);
  const files = children.filter((f) => f.mimeType !== FOLDER_MIME);

  return files.map((file) => {
    const fields = resolveFields(file.name, folderIsoDate);
    return {
      fileId: file.id,
      fileName: file.name,
      webViewLink: file.webViewLink,
      location: locationName,
      ...fields,
    };
  });
}

async function collectYearFolderRecords(
  locationName: string,
  yearFolder: DriveFileWithLink
): Promise<DepositRecord[]> {
  const children = await listChildrenWithLinks(yearFolder.id);
  const dateFolders = children.filter((f) => f.mimeType === FOLDER_MIME);
  const perDate = await Promise.all(
    dateFolders.map((dateFolder) => collectDateFolderRecords(locationName, dateFolder))
  );
  return perDate.flat();
}

async function collectLocationRecords(locationFolder: DriveFileWithLink): Promise<DepositRecord[]> {
  const children = await listChildrenWithLinks(locationFolder.id);
  const yearFolders = children.filter((f) => f.mimeType === FOLDER_MIME);
  const perYear = await Promise.all(
    yearFolders.map((yearFolder) => collectYearFolderRecords(locationFolder.name, yearFolder))
  );
  return perYear.flat();
}

/**
 * GET /api/deposit-review/summary — walks `Deposit Slips` (location → year →
 * date folder → files), parses every filename, and returns aggregate counts
 * plus the 50 most recent uploads. Read-only: no writes to Drive.
 */
export async function GET() {
  // requireAuth throws NEXT_REDIRECT — must run outside the try so Next handles it.
  await requireAuth();

  try {
    const root = process.env.DEPOSIT_SLIPS_FOLDER_ID;
    if (!root) throw new Error('DEPOSIT_SLIPS_FOLDER_ID is not set');

    const topLevel = await listChildrenWithLinks(root);
    const locationFolders = topLevel.filter(
      (f) => f.mimeType === FOLDER_MIME && !NOT_A_LOCATION.test(f.name)
    );

    const perLocation = await Promise.all(locationFolders.map(collectLocationRecords));
    const records = perLocation.flat();

    const summary = buildSummary(
      records,
      locationFolders.map((f) => f.name).sort()
    );

    return NextResponse.json(summary);
  } catch (error: unknown) {
    console.error('[deposit-review/summary]', error);
    return NextResponse.json({ error: 'Could not reach Google Drive' }, { status: 502 });
  }
}
