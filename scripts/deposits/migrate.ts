import { config } from 'dotenv';
config({ path: '.env.local' });

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { listChildren, ensurePath } from '../../src/lib/google/drive';
import { getAccessToken } from '../../src/lib/google/serviceAccount';
import { parseLegacyName, buildFileName, type DepositType } from '../../src/lib/deposits/naming';

/**
 * One-off migration of the 49 legacy files under Deposit Slips/ into the new
 * {Location}/{YYYY}/{YYYY-MM-DD}/ tree.
 *
 * Dry-run by default: inventories the tree and writes a manifest, touching
 * nothing on Drive. `--execute` performs the actual moves/renames, and
 * REFUSES to run unless every manifest entry already has a type and a target
 * (see `isReady` below).
 *
 * Folder creation order matters: `ensurePath` is find-then-create per segment,
 * which is TOCTOU-unsafe under concurrency — two callers that both see a
 * segment missing will both create it, producing a duplicate folder that
 * silently orphans whichever files land in the "wrong" copy. This script
 * never risks that: every target folder is pre-created ONE AT A TIME, fully
 * up front, before any file move is attempted. There is no parallel loop over
 * ensurePath, and no in-process promise-map memoization trick either — that
 * would only guard against concurrent calls within this one process, and
 * would do nothing if the script were ever invoked twice at once. Strict
 * sequencing is the only fix that actually holds.
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT = process.env.DEPOSIT_SLIPS_FOLDER_ID;
const EXECUTE = process.argv.includes('--execute');
const TARGET_LOCATION = 'Florida';
// The new top-level location folders are the migration's DESTINATION, not
// input — they must never be walked as sources, only skipped at the root.
const LOCATION_FOLDERS = new Set(['Florida', 'Tennessee', 'Texas']);

const MANIFEST_PATH = path.resolve(
  __dirname,
  '../../../docs/deposits/migration-manifest.json'
);

interface ManifestEntry {
  fileId: string;
  /** The folder the file lives in today — needed as removeParents on the move. */
  currentParentId: string;
  originalPath: string;
  originalName: string;
  parsedDate: string | null;
  parsedAmount: string | null;
  /** Blank when not inferable — a human fills this in before --execute. */
  type: DepositType | '';
  targetPath: string | null;
  targetName: string | null;
  note: string;
}

/** Manifest entries that --execute is allowed to act on: date, type and target all present. */
type ReadyEntry = ManifestEntry & { targetPath: string; targetName: string; type: DepositType };

function isReady(entry: ManifestEntry): entry is ReadyEntry {
  return entry.targetPath !== null && entry.targetName !== null && entry.type !== '';
}

async function collect(folderId: string, prefix: string, out: ManifestEntry[]): Promise<void> {
  for (const child of await listChildren(folderId)) {
    if (child.mimeType === FOLDER_MIME) {
      // Skip the new top-level location folders — they are the destination.
      if (prefix === '' && LOCATION_FOLDERS.has(child.name)) continue;
      await collect(child.id, `${prefix}/${child.name}`, out);
      continue;
    }

    const parsed = parseLegacyName(child.name);
    out.push({
      fileId: child.id,
      currentParentId: folderId,
      originalPath: `${prefix}/${child.name}`,
      originalName: child.name,
      parsedDate: parsed.isoDate,
      parsedAmount: parsed.amount,
      type: parsed.type ?? '',
      targetPath: null,
      targetName: null,
      note: parsed.isoDate ? '' : 'DATE NOT PARSED — fill parsedDate manually',
    });
  }
}

function planTargets(entries: ManifestEntry[]): void {
  const seqByFolder = new Map<string, number>();

  for (const entry of entries) {
    if (!entry.parsedDate || !entry.type) {
      if (!entry.note) {
        entry.note = !entry.type
          ? 'TYPE MISSING — set "Deposit" or "Check" before --execute'
          : 'DATE NOT PARSED — fill parsedDate manually';
      }
      continue;
    }
    const folder = `${TARGET_LOCATION}/${entry.parsedDate.slice(0, 4)}/${entry.parsedDate}`;
    const seq = (seqByFolder.get(folder) ?? 0) + 1;
    seqByFolder.set(folder, seq);

    entry.targetPath = folder;
    entry.targetName = buildFileName({
      isoDate: entry.parsedDate,
      type: entry.type,
      amount: entry.parsedAmount,
      uploader: null, // unrecoverable for historical files — Drive `owners` is empty on a Shared Drive
      seq,
      ext: (/\.[^.]+$/.exec(entry.originalName) ?? ['.jpg'])[0],
    });
  }
}

/**
 * Creates every distinct target folder SEQUENTIALLY, one at a time, before a
 * single file is moved. See the module-level note on why this must not be
 * parallelised or memoized with an in-process promise map.
 */
async function preCreateFolders(
  rootId: string,
  entries: ReadonlyArray<Pick<ReadyEntry, 'targetPath'>>
): Promise<Map<string, string>> {
  const folderIds = new Map<string, string>();

  for (const entry of entries) {
    if (folderIds.has(entry.targetPath)) continue;
    const segments = entry.targetPath.split('/');
    const folderId = await ensurePath(rootId, segments);
    folderIds.set(entry.targetPath, folderId);
  }

  return folderIds;
}

async function runExecute(rootId: string): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error('No manifest found. Run without --execute first, then review it.');
  }
  const entries = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as ManifestEntry[];

  const blocked = entries.filter((entry) => !isReady(entry));
  if (blocked.length > 0) {
    console.error(`${blocked.length} entries are missing a type or target. Fill them in, then re-run.`);
    for (const entry of blocked) console.error(`  ${entry.originalPath} — ${entry.note}`);
    process.exit(1);
    return;
  }

  const ready = entries.filter(isReady);

  console.log(`Pre-creating target folders for ${ready.length} files (sequential, one at a time)...`);
  const folderIds = await preCreateFolders(rootId, ready);
  console.log(`${folderIds.size} distinct target folders ready.`);

  for (const entry of ready) {
    const folderId = folderIds.get(entry.targetPath);
    if (!folderId) {
      console.error(`FAILED ${entry.originalPath}: no pre-created folder for ${entry.targetPath}`);
      continue;
    }

    // removeParents is REQUIRED: addParents alone gives the file TWO parents,
    // so it would appear in both the old and the new location.
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(entry.fileId)}` +
        `?supportsAllDrives=true&addParents=${encodeURIComponent(folderId)}` +
        `&removeParents=${encodeURIComponent(entry.currentParentId)}&fields=id,name,parents`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${await getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: entry.targetName }),
      }
    );
    if (!response.ok) {
      console.error(`FAILED ${entry.originalPath}: ${response.status} ${await response.text()}`);
      continue;
    }
    console.log(`moved  ${entry.originalPath}  ->  ${entry.targetPath}/${entry.targetName}`);
  }

  console.log('\nDone. Old year folders are now empty — trash them in Drive manually.');
  console.log('The service account cannot permanently delete; a Manager must empty the trash.');
}

async function runDryRun(rootId: string): Promise<void> {
  const entries: ManifestEntry[] = [];
  await collect(rootId, '', entries);
  planTargets(entries);

  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2), 'utf-8');

  const needsType = entries.filter((e) => !e.type).length;
  console.log(`DRY RUN — ${entries.length} files inventoried`);
  console.log(`manifest: ${MANIFEST_PATH}`);
  console.log(`${needsType} entries need a type filled in before --execute`);
  console.log('\nNothing was written to Drive. Review the manifest, fill in blanks, then:');
  console.log('  npx tsx scripts/deposits/migrate.ts --execute');
}

async function main(): Promise<void> {
  if (!ROOT) throw new Error('DEPOSIT_SLIPS_FOLDER_ID is not set');

  if (EXECUTE) {
    await runExecute(ROOT);
    return;
  }

  await runDryRun(ROOT);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
