import { config } from 'dotenv';
config({ path: '.env.local' });

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { listChildren, ensurePath, findFolder } from '../../src/lib/google/drive';
import { getAccessToken } from '../../src/lib/google/serviceAccount';
import {
  parseLegacyName,
  buildFileName,
  buildFolderSegments,
  nextSequence,
  type DepositType,
} from '../../src/lib/deposits/naming';

/**
 * One-off migration of the 49 legacy files under Deposit Slips/ into the new
 * {Location}/{YYYY}/{YYYY-MM-DD}/ tree.
 *
 * Dry-run by default: inventories the tree and writes a manifest, touching
 * nothing on Drive. Refuses to overwrite an existing manifest unless `--force`
 * is passed (it may hold human-entered types and is the only revert record for
 * anything already migrated).
 *
 * `--plan` loads the EXISTING manifest from disk (never re-collects from
 * Drive, never overwrites it) and previews exactly what `--execute` would do:
 * the same blocking gate, the same `planTargets`/`assertUniqueTargets`. It
 * makes zero Drive calls and exits without touching anything. This is the only
 * way a human can see the final plan for entries they just filled in a `type`
 * for — the dry run refuses to overwrite the manifest, and `--force` would
 * re-collect from Drive and discard their edits.
 *
 * `--execute` performs the actual moves/renames, and REFUSES to run unless
 * every manifest entry already has a valid date and type (see
 * `hasValidHumanInput` below) — targetPath/targetName are always recomputed by
 * `planTargets` at execute time, never taken from the manifest as written.
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
 * sequencing is the only fix that actually holds. The same discipline applies
 * to `seedSequences` below, for the same reason.
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT = process.env.DEPOSIT_SLIPS_FOLDER_ID;
const EXECUTE = process.argv.includes('--execute');
const PLAN = process.argv.includes('--plan');
// Only permits runDryRun to overwrite an existing manifest. See runDryRun.
const FORCE = process.argv.includes('--force');
const TARGET_LOCATION = 'Florida';
// The new top-level location folders are the migration's DESTINATION, not
// input — they must never be walked as sources, only skipped at the root.
const LOCATION_FOLDERS = new Set(['Florida', 'Tennessee', 'Texas']);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Whatever a real file on Drive could plausibly be. Anything else (a typo, a
// junk suffix) falls back to `.jpg` in resolveExtension rather than being
// trusted verbatim.
const KNOWN_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.pdf', '.heic', '.heif', '.webp']);

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
 * Runtime validation of what a HUMAN must supply before --execute may touch
 * an entry: an exact `'Deposit'` or `'Check'` type, and a `parsedDate` that is
 * actually shaped like `YYYY-MM-DD`. The manifest is `JSON.parse`d with no
 * schema check, so without this, a typo — lowercase `"deposit"`, `"Cash"`, a
 * hand-typed `"7/14/26"` — flows straight through to a live Drive write.
 * `targetPath`/`targetName` are deliberately NOT part of this check — those
 * are machine-derived by planTargets (called from runExecute below) and must
 * never be hand-authored, so their presence or absence says nothing about
 * whether the entry is ready.
 */
function hasValidHumanInput(
  entry: ManifestEntry
): entry is ManifestEntry & { parsedDate: string; type: DepositType } {
  return (
    (entry.type === 'Deposit' || entry.type === 'Check') &&
    entry.parsedDate !== null &&
    ISO_DATE_RE.test(entry.parsedDate)
  );
}

/** Convenience negation of hasValidHumanInput, for filter() readability at call sites. */
function needsHumanInput(entry: ManifestEntry): boolean {
  return !hasValidHumanInput(entry);
}

function resolveExtension(originalName: string): string {
  const match = /\.[^.]+$/.exec(originalName);
  const ext = (match ? match[0] : '.jpg').toLowerCase();
  return KNOWN_EXTENSIONS.has(ext) ? ext : '.jpg';
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

/**
 * Derives targetPath/targetName for every entry, in place. Always the ONLY
 * place targets are derived — never trust whatever a human (or a stale
 * manifest) wrote into those fields directly.
 *
 * `initialSeqByFolder` seeds each target folder's running sequence counter
 * (Fix 5) — used by runExecute (only) to account for files already sitting in
 * a target folder from a prior partial run. --plan and the dry run always
 * call this with no seed, i.e. every folder is assumed empty.
 *
 * Idempotent and side-effect-free beyond mutating the passed entries: safe to
 * call more than once on the same array (runExecute does, once unseeded to
 * discover folders, once seeded with real Drive-derived starting numbers).
 */
function planTargets(
  entries: ManifestEntry[],
  initialSeqByFolder: ReadonlyMap<string, number> = new Map()
): void {
  const seqByFolder = new Map(initialSeqByFolder);

  for (const entry of entries) {
    // An already-moved entry's targetPath/targetName describe exactly where
    // the file sits on Drive right now — recomputing here would overwrite
    // the manifest's only record of where it actually went with a fresh,
    // higher name that no longer matches reality. Still bump its folder's
    // sequence counter so a sibling being planned fresh in the same folder
    // can't be assigned a name that collides with it.
    if (entry.outcome === 'moved') {
      if (entry.targetPath !== null) {
        const seq = (seqByFolder.get(entry.targetPath) ?? 0) + 1;
        seqByFolder.set(entry.targetPath, seq);
      }
      continue;
    }

    entry.targetPath = null;
    entry.targetName = null;

    if (!hasValidHumanInput(entry)) {
      if (!entry.note) {
        const typeInvalid = entry.type !== 'Deposit' && entry.type !== 'Check';
        const dateInvalid = entry.parsedDate === null || !ISO_DATE_RE.test(entry.parsedDate);
        if (typeInvalid && dateInvalid) {
          entry.note =
            'TYPE AND DATE INVALID — type must be exactly "Deposit" or "Check"; parsedDate must be YYYY-MM-DD';
        } else if (typeInvalid) {
          entry.note = `TYPE INVALID (${JSON.stringify(entry.type)}) — must be exactly "Deposit" or "Check"`;
        } else {
          entry.note = `DATE INVALID (${JSON.stringify(entry.parsedDate)}) — must be YYYY-MM-DD`;
        }
      }
      continue;
    }

    // buildFolderSegments carries the real validation (calendar-real date,
    // not in the future, not before 2020) — route through it instead of
    // hand-concatenating a path, so a garbage hand-typed date can never turn
    // into a garbage Drive path.
    let segments: string[];
    try {
      segments = buildFolderSegments(TARGET_LOCATION, entry.parsedDate);
    } catch (error: unknown) {
      entry.note = error instanceof Error ? error.message : String(error);
      continue;
    }

    const folder = segments.join('/');
    const seq = (seqByFolder.get(folder) ?? 0) + 1;
    seqByFolder.set(folder, seq);

    entry.targetPath = folder;
    entry.targetName = buildFileName({
      isoDate: entry.parsedDate,
      type: entry.type,
      amount: entry.parsedAmount,
      uploader: null, // unrecoverable for historical files — Drive `owners` is empty on a Shared Drive
      seq,
      ext: resolveExtension(entry.originalName),
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

/**
 * (Fix 5) Looks up, per distinct target folder, how far its sequence counter
 * already is on Drive — read-only, never creates anything. Only meaningful
 * (and only ever called) from runExecute: a re-run after a partial failure
 * can find files already sitting in a target folder (Fix 3 skips re-moving
 * them, but planTargets still needs to not reissue their sequence numbers to
 * the entries still pending).
 *
 * A folder that doesn't exist yet needs no seed — 0 (i.e. "start at 1") is
 * already correct in that case.
 *
 * Sequential by the same discipline as preCreateFolders/ensurePath above: one
 * folder looked up at a time, no Promise.all/map(async).
 */
async function seedSequences(
  rootId: string,
  entries: ReadonlyArray<Pick<ReadyEntry, 'targetPath'>>
): Promise<Map<string, number>> {
  const seeds = new Map<string, number>();
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.targetPath)) continue;
    seen.add(entry.targetPath);

    const segments = entry.targetPath.split('/');
    let parentId: string | null = rootId;
    for (const segment of segments) {
      if (parentId === null) break;
      const found = await findFolder(parentId, segment);
      parentId = found ? found.id : null;
    }
    if (parentId === null) continue; // folder doesn't exist yet — 0 is already correct

    const children = await listChildren(parentId);
    seeds.set(entry.targetPath, nextSequence(children.map((child) => child.name)) - 1);
  }

  return seeds;
}

/**
 * (Fix 4) Writes to a temp file in the same directory, then renames over the
 * target — rename is atomic on the same volume, so a kill mid-write can never
 * truncate the manifest (the only revert record once files start moving).
 */
function persistManifest(entries: ManifestEntry[]): void {
  const dir = path.dirname(MANIFEST_PATH);
  const tempPath = path.join(dir, `.migration-manifest.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tempPath, JSON.stringify(entries, null, 2), 'utf-8');
  renameSync(tempPath, MANIFEST_PATH);
}

async function runExecute(rootId: string): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error('No manifest found. Run without --execute first, then review it.');
  }

  const entries = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as ManifestEntry[];

  // Recompute targetPath/targetName fresh, from the human-supplied type/
  // parsedDate only. This is the ONLY place targets are derived for --execute
  // — never trust whatever a human (or a stale manifest) wrote into those
  // fields directly. First pass is unseeded: its only job here is to surface,
  // via isReady, every reason an entry isn't ready — invalid type/date shape
  // (Fix 2) as well as buildFolderSegments rejecting a shape-valid but
  // impossible/future/too-old date.
  planTargets(entries);

  const blocked = entries.filter((entry) => !isReady(entry));
  if (blocked.length > 0) {
    console.error(`${blocked.length} entries are not ready for --execute. Fix them, then re-run:`);
    for (const entry of blocked) console.error(`  ${entry.originalPath} — ${entry.note}`);
    process.exit(1);
    return;
  }

  // (Fix 5) Seed each target folder's starting sequence number from what's
  // already on Drive, then recompute with the real starting numbers. Only
  // runExecute ever does this Drive read — --plan and the dry run stay
  // read-light/write-free and assume every folder starts empty.
  const seeds = await seedSequences(rootId, entries.filter(isReady));
  planTargets(entries, seeds);

  const ready = entries.filter(isReady);
  if (ready.length !== entries.length) {
    throw new Error(
      `internal error: ${entries.length - ready.length} entries became blocked between planning passes`
    );
  }

  assertUniqueTargets(ready);

  // (Fix 4) The pre-execute state must survive even if the run is killed
  // mid-way, independent of persistManifest's atomic per-entry writes below —
  // this is the one copy that always reflects "before anything moved".
  // Deliberately placed here, after the readiness gate and the uniqueness
  // assertion have both passed, and immediately before the first Drive write
  // (preCreateFolders below) — a doomed --execute attempt (missing type/date
  // on some entries, or a collision) exits 1 above without ever dropping a
  // backup file into docs/deposits/.
  const backupPath = path.join(
    path.dirname(MANIFEST_PATH),
    `migration-manifest.pre-execute-${Date.now()}.json`
  );
  copyFileSync(MANIFEST_PATH, backupPath);
  console.log(`Pre-execute backup written to ${backupPath}`);

  console.log(`Pre-creating target folders for ${ready.length} files (sequential, one at a time)...`);
  const folderIds = await preCreateFolders(rootId, ready);
  console.log(`${folderIds.size} distinct target folders ready.`);

  let skipped = 0;

  try {
    for (const entry of ready) {
      // (Fix 3) An already-moved entry's currentParentId is stale — it is no
      // longer the file's actual parent on Drive. Re-attempting the move
      // would be rejected by Drive and flip outcome from 'moved' back to
      // 'failed', corrupting the only revert record.
      if (entry.outcome === 'moved') {
        skipped++;
        continue;
      }

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

  console.log(`\n${skipped} entries already moved were skipped.`);
  console.log('Done. Old year folders are now empty — trash them in Drive manually.');
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
  const blocked = entries.filter((e) => !isReady(e)).length;
  console.log(`DRY RUN — ${entries.length} files inventoried`);
  console.log(`manifest: ${MANIFEST_PATH}`);
  console.log(`${blocked} entries blocked before --execute (${needsType} missing type, ${needsDate} missing date)`);
  console.log('\nNothing was written to Drive. Review the manifest, fill in blanks, then:');
  console.log('  npx tsx scripts/deposits/migrate.ts --plan     (preview the final plan, no Drive writes)');
  console.log('  npx tsx scripts/deposits/migrate.ts --execute');
}

/**
 * (Fix 1) Loads the manifest exactly as --execute would, runs the identical
 * blocking gate and the identical planTargets/assertUniqueTargets, and prints
 * the result — WITHOUT ever writing to Drive or to the manifest on disk.
 *
 * Never re-collects from Drive (so it can never discard a human's edits the
 * way --force does), and unlike runExecute it does not abort early when some
 * entries are blocked — showing both the ready plan and the blocked list
 * together is the entire point of a preview.
 *
 * Makes zero Drive calls: planTargets (unseeded) and assertUniqueTargets are
 * both pure, in-memory functions. See the printed note about Fix 5's
 * execute-only sequence seeding for the one way this preview's exact
 * filenames can differ from what --execute actually assigns.
 */
function runPlan(): void {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`No manifest found at ${MANIFEST_PATH}.`);
    console.error('Run the script with no flags first to inventory the tree, fill in blanks, then --plan.');
    process.exit(1);
    return;
  }

  const entries = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as ManifestEntry[];

  // Same machinery --execute uses to derive targets — reused, not
  // reimplemented, so --plan can never drift from what --execute will
  // actually do (only the sequence-number seeding differs; see the note
  // printed below).
  planTargets(entries);

  const ready = entries.filter(isReady);
  const blocked = entries.filter((entry) => !isReady(entry));

  assertUniqueTargets(ready);

  console.log(`PLAN — ${entries.length} entries: ${ready.length} ready, ${blocked.length} blocked\n`);

  for (const entry of ready) {
    console.log(`${entry.originalPath}  ->  ${entry.targetPath}/${entry.targetName}`);
  }

  console.log(`\n${ready.length} planned moves.`);

  if (blocked.length > 0) {
    console.log(`\n${blocked.length} blocked entries:`);
    for (const entry of blocked) {
      console.log(`  ${entry.originalPath} — ${entry.note}`);
    }
  }

  console.log(
    '\nNote (Fix 5): sequence numbers above assume every target folder starts empty. --execute instead ' +
      "seeds each folder's starting sequence from what already exists on Drive (a read that only " +
      '--execute performs) — so if a target folder is non-empty when --execute actually runs (e.g. a ' +
      'prior partial run already moved files into it), the real filenames --execute assigns can differ ' +
      'from this preview.'
  );
  console.log('\n--plan made no changes to Drive or to the manifest on disk.');
}

async function main(): Promise<void> {
  if (!ROOT) throw new Error('DEPOSIT_SLIPS_FOLDER_ID is not set');

  if (EXECUTE) {
    await runExecute(ROOT);
    return;
  }

  if (PLAN) {
    runPlan();
    return;
  }

  await runDryRun(ROOT);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
