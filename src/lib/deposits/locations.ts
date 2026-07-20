import { listChildren } from '../google/drive';

/**
 * Shared "what counts as a location folder" rule for the deposit portal.
 *
 * Used by both GET /api/deposits/locations (to populate the dropdown) and
 * POST /api/deposits/upload (to validate the submitted `location` BEFORE it
 * reaches `ensurePath`, which would otherwise create — or write into — any
 * folder name handed to it, including the legacy year folders).
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Year folders are the pre-migration structure; they are not locations.
export const NOT_A_LOCATION = /^(?:\d{4}|__.*)$/;

/** Folder names directly under the given root that count as real locations. */
export async function listLocations(rootId: string): Promise<string[]> {
  const children = await listChildren(rootId);
  return children
    .filter((f) => f.mimeType === FOLDER_MIME && !NOT_A_LOCATION.test(f.name))
    .map((f) => f.name)
    .sort();
}
