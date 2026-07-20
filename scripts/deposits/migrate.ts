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
 * nothing on Drive. Refuses to overwrite an existing manifest unless `--force`
 * is passed (it may hold human-entered types and is the only revert record for
 * anything already migrated).
 *
 * `--execute` performs the actual moves/renames, and REFUSES to run unless
 * every manifest entry already has a date and a type (see `needsHumanInput`
 * below) — targetPath/targetName are always recomputed by `planTargets` at
 * execute time, never taken from the manifest as written.
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
// Only permits runDryRun to overwrite an existing manifest. See runDryRun.
const FORCE = process.argv.includes('--force');
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
  /** Set by --execute as it processes each entry; null until then. */
  outcome: 'moved' | 'failed' | null;
  /** Short failure detail, set alongside outcome: 'failed'. */
  outcomeError: string | null;
}

/** Manifest entries that --execute is allowed to act on: date, type and target all present. */
type ReadyEntry = ManifestEntry & { targetPath: string; targetName: string; type: DepositType };

function isReady(entry: ManifestEntry): entry is ReadyEntry {
  return entry.targetPath !== null && entry.targetName !== null && entry.type !== '';
}

/**
 * What a HUMAN must supply before --execute may touch an entry: a parsed date
 * and a type. targetPath/targetName are deliberately NOT part of this check —
 * those are machine-derived by planTargets (called from runExecute below) and
 * must never be hand-authored, so their presence or absence says nothing about
 * whether the entry is ready.
 */
function needsHumanInput(entry: ManifestEntry): boolean {
  return entry.parsedDate === null || entry.type === '';
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
    // The filename doesn't always carry a date — some legacy files were dropped
    // straight into a date-named folder (e.g. "7.14.26") with no date of their
    // own. Fall back to parsing the containing folder's name for the DATE only;
    // amount and type are never inferable from a folder name.
    //
    // parseLegacyName strips what it assumes is a file extension
    // (`/\.[^.]+$/`) before matching. A bare folder name like "7.14.26" has no
    // real extension, so that strip chops off the last "26" as if it were one,
    // leaving "7.14" — which the date regex (needs 3 groups) can't match.
    // Appending a harmless extension gives it something real to strip instead,
    // so the full "7.14.26" survives intact for matching.
    const folderName = prefix.slice(prefix.lastIndexOf('/') + 1);
    const isoDate = parsed.isoDate ?? parseLegacyName(`${folderName}.ext`).isoDate;
    out.push({
      fileId: child.id,
      currentParentId: folderId,
      originalPath: `${prefix}/${child.name}`,
      originalName: child.name,
      parsedDate: isoDate,
      parsedAmount: parsed.amount,
      type: parsed.type ?? '',
      targetPath: null,
      targetName: null,
      note: isoDate ? '' : 'DATE NOT PARSED — fill parsedDate manually',
      outcome: null,
      outcomeError: null,
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
 * Belt-and-suspenders check after planTargets: two entries landing on the same
 * targetPath/targetName would be indistinguishable deposit slips once moved —
 * Drive allows duplicate filenames in a folder without error. Refuses to touch
 * Drive if any collision exists.
 */
function assertUniqueTargets(entries: ReadonlyArray<ReadyEntry>): void {
  const byKey = new Map<string, string[]>();
  for (const entry of entries) {
    const key = `${entry.targetPath}/${entry.targetName}`;
    const paths = byKey.get(key) ?? [];
    paths.push(entry.originalPath);
    byKey.set(key, paths);
  }

  const collisions = [...byKey.entries()].filter(([, paths]) => paths.length > 1);
  if (collisions.length === 0) return;

  console.error(`${collisions.length} target collisions detected — refusing to touch Drive:`);
  for (const [key, paths] of collisions) {
    console.error(`  ${key}`);
    for (const p of paths) console.error(`    <- ${p}`);
  }
  process.exit(1);
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

function persistManifest(entries: ManifestEntry[]): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2), 'utf-8');
}

async function runExecute(rootId: string): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error('No manifest found. Run without --execute first, then review it.');
  }
  const entries = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as ManifestEntry[];

  // Gate on what a HUMAN had to supply — parsedDate and type. targetPath/
  // targetName are never a gating input: they are recomputed below by
  // planTargets so they can never be stale or hand-authored.
  const blocked = entries.filter(needsHumanInput);
  if (blocked.length > 0) {
    console.error(`${blocked.length} entries are missing a date or type. Fill them in, then re-run.`);
    for (const entry of blocked) console.error(`  ${entry.originalPath} — ${entry.note}`);
    process.exit(1);
    return;
  }

  // Recompute targetPath/targetName fresh, from the human-supplied type/
  // parsedDate only. This is the ONLY place targets are derived for --execute
  // — never trust whatever a human (or a stale manifest) wrote into those
  // fields directly.
  planTargets(entries);

  const ready = entries.filter(isReady);
  if (ready.length !== entries.length) {
    throw new Error(
      `internal error: ${entries.length - ready.length} entries passed the human-input gate but planTargets ` +
        'did not produce a target for them.'
    );
  }

  assertUniqueTargets(ready);

  console.log(`Pre-creating target folders for ${ready.length} files (sequential, one at a time)...`);
  const folderIds = await preCreateFolders(rootId, ready);
  console.log(`${folderIds.size} distinct target folders ready.`);

  try {
    for (const entry of ready) {
      const folderId = folderIds.get(entry.targetPath);
      if (!folderId) {
        entry.outcome = 'failed';
        entry.outcomeError = `no pre-created folder for ${entry.targetPath}`;
        console.error(`FAILED ${entry.originalPath}: ${entry.outcomeError}`);
        persistManifest(entries);
        continue;
      }

      try {
        // removeParents is REQUIRED: addParents alone gives the file TWO
        // parents, so it would appear in both the old and the new location.
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
          entry.outcome = 'failed';
          entry.outcomeError = `${response.status} ${await response.text()}`;
          console.error(`FAILED ${entry.originalPath}: ${entry.outcomeError}`);
        } else {
          entry.outcome = 'moved';
          entry.outcomeError = null;
          console.log(`moved  ${entry.originalPath}  ->  ${entry.targetPath}/${entry.targetName}`);
        }
      } catch (error: unknown) {
        entry.outcome = 'failed';
        entry.outcomeError = error instanceof Error ? error.message : String(error);
        console.error(`FAILED ${entry.originalPath}: ${entry.outcomeError}`);
      }

      persistManifest(entries);
    }
  } finally {
    // Belt-and-suspenders: guarantees an interrupted run still leaves the
    // manifest reflecting everything it got through, even if some future
    // change to this loop lets an error escape the per-entry try/catch above.
    persistManifest(entries);
  }

  console.log('\nDone. Old year folders are now empty — trash them in Drive manually.');
  console.log('The service account cannot permanently delete; a Manager must empty the trash.');
}

async function runDryRun(rootId: string): Promise<void> {
  // Root-level Florida/Tennessee/Texas are correctly skipped as SOURCES in
  // collect() — so once files have been migrated there, re-collecting from
  // Drive produces a manifest that OMITS them entirely. Overwriting the
  // existing manifest in that state would silently erase the only record of
  // those files' original names and original parent folder ids (needed for
  // any revert), and would also throw away any human-entered `type` values
  // and any `outcome`/`outcomeError` recorded by a prior --execute run.
  if (existsSync(MANIFEST_PATH) && !FORCE) {
    console.error(`Manifest already exists: ${MANIFEST_PATH}`);
    console.error(
      'Refusing to overwrite it. It may contain human-entered types, and for any files already ' +
        'migrated (now correctly excluded from a fresh collect()) it is the ONLY remaining record ' +
        'of their original name and original parent folder — the revert record.'
    );
    console.error('If you genuinely intend to regenerate it from scratch, re-run with --force.');
    console.error('The current manifest will be preserved alongside it as migration-manifest.backup.json.');
    process.exit(1);
    return;
  }

  if (existsSync(MANIFEST_PATH) && FORCE) {
    const backupPath = path.join(path.dirname(MANIFEST_PATH), 'migration-manifest.backup.json');
    writeFileSync(backupPath, readFileSync(MANIFEST_PATH, 'utf-8'), 'utf-8');
    console.log(`--force: preserved the existing manifest as ${backupPath}`);
  }

  const entries: ManifestEntry[] = [];
  await collect(rootId, '', entries);
  planTargets(entries);

  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2), 'utf-8');

  const needsType = entries.filter((e) => !e.type).length;
  const needsDate = entries.filter((e) => e.parsedDate === null).length;
  const blocked = entries.filter(needsHumanInput).length;
  console.log(`DRY RUN — ${entries.length} files inventoried`);
  console.log(`manifest: ${MANIFEST_PATH}`);
  console.log(`${blocked} entries blocked before --execute (${needsType} missing type, ${needsDate} missing date)`);
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
