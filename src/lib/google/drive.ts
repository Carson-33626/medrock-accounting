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

  if (response.status === 204) return {} as T;

  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? JSON.stringify((body as { error: unknown }).error)
        : String(response.status);
    throw new Error(`Drive API ${response.status}: ${message}`);
  }
  return body as T;
}

/** Drive query strings are single-quoted; a literal quote must be escaped. */
const escapeQuery = (value: string): string => value.replace(/'/g, "\\'");

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
      (pageToken ? `&pageToken=${pageToken}` : '');

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
      body: new Uint8Array(body),
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
