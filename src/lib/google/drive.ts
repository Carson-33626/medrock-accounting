import crypto from 'node:crypto';
import { getAccessToken } from './serviceAccount';

/**
 * Minimal Google Drive v3 client for the deposit portal.
 *
 * EVERY call sets supportsAllDrives=true (and includeItemsFromAllDrives on
 * lists). Omitting them against a Shared Drive returns empty results rather
 * than an error, which is extremely hard to debug.
 *
 * There is deliberately no permanent-delete function: the service account is a
 * Content Manager and cannot permanently delete (Drive answers 404). Removal is
 * always trash. See spec §10.3.
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

interface DriveListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await getAccessToken()}` };
}

async function driveFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(await authHeaders()), ...(init?.headers ?? {}) },
  });

  // 204 (e.g. trash PATCH with no fields) has an empty body — never attempt
  // to parse it as JSON.
  if (response.status === 204) {
    if (!response.ok) {
      throw new Error(`Drive API ${response.status}: (no body)`);
    }
    return {} as T;
  }

  const raw = await response.text();
  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = raw === '' ? {} : JSON.parse(raw);
  } catch {
    parseFailed = true;
  }

  if (!response.ok) {
    const detail =
      !parseFailed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? JSON.stringify((parsed as { error: unknown }).error)
        : `non-JSON body: ${raw.slice(0, 200)}`;
    throw new Error(`Drive API ${response.status}: ${detail}`);
  }

  return parsed as T;
}

/**
 * Drive query strings are single-quoted; both `\` and `'` are special inside
 * them. Escape the backslash FIRST, then the quote — reversing the order
 * would re-escape the backslashes just inserted for the quote, corrupting
 * the literal. Do not "simplify" this to a single replace.
 */
const escapeQuery = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function findFolder(parentId: string, name: string): Promise<DriveFile | null> {
  const q = encodeURIComponent(
    `'${escapeQuery(parentId)}' in parents and name='${escapeQuery(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`
  );
  const result = await driveFetch<DriveListResponse>(
    `${API}?q=${q}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType)`
  );
  return result.files?.[0] ?? null;
}

export async function createFolder(parentId: string, name: string): Promise<DriveFile> {
  return driveFetch<DriveFile>(`${API}?supportsAllDrives=true&fields=id,name,mimeType`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
}

/**
 * Walks/creates each segment in turn, returning the leaf folder id.
 * Find-then-create per segment — never create blind, or a duplicate folder
 * silently orphans files.
 */
export async function ensurePath(rootId: string, segments: string[]): Promise<string> {
  let parentId = rootId;
  for (const segment of segments) {
    const existing = await findFolder(parentId, segment);
    parentId = existing ? existing.id : (await createFolder(parentId, segment)).id;
  }
  return parentId;
}

export async function listChildren(parentId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const q = encodeURIComponent(`'${escapeQuery(parentId)}' in parents and trashed=false`);
    const url =
      `${API}?q=${q}&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      `&fields=nextPageToken,files(id,name,mimeType)&pageSize=200&orderBy=name` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

    const page = await driveFetch<DriveListResponse>(url);
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  return files;
}

export async function uploadFile(
  parentId: string,
  name: string,
  mimeType: string,
  bytes: Buffer
): Promise<DriveFile> {
  const boundary = `medrock-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, parents: [parentId] });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return driveFetch<DriveFile>(
    `${UPLOAD_API}?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }
  );
}

/** Trash — never permanent delete. See the module note above. */
export async function trashFile(fileId: string): Promise<void> {
  await driveFetch<DriveFile>(`${API}/${fileId}?supportsAllDrives=true&fields=id,name,mimeType`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}
