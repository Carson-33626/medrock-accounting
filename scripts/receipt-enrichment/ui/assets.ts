// scripts/receipt-enrichment/ui/assets.ts
//
// Static asset reader for the Sweep Control Panel. The page used to be a single exported template
// literal (sweep-ui-page.ts); it is now three real files you can open and edit. Serving files
// instead of a string introduces exactly one new risk — path traversal — so this module never
// joins a client-supplied string onto a directory. `ASSETS` is a closed map from an exact request
// path to an exact filename, the same closed-registry discipline actions.ts uses for argv. An
// unknown name is a miss, not a filesystem lookup.
//
// __dirname is the right tool HERE (unlike the session paths in engines/receipt-capture, which had
// to move to paths.ts): these files genuinely live next to this module and travel with it.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Asset {
  body: string;
  contentType: string;
}

/** Request path -> [filename on disk, Content-Type]. Nothing outside this map is servable. */
const ASSETS: Readonly<Record<string, readonly [string, string]>> = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

export const ASSET_PATHS: readonly string[] = Object.keys(ASSETS);

export const INDEX_FILE = 'index.html';

export type AssetReader = (requestPath: string) => Asset | null;

/**
 * Reads from `dir` (defaults to this module's own directory). Re-reads on every request rather
 * than caching: this is a loopback panel for one operator, and picking up an edit to app.js on
 * refresh — with no server restart — is worth more here than avoiding a small file read.
 */
export function makeAssetReader(dir: string = __dirname): AssetReader {
  return (requestPath) => {
    const entry = ASSETS[requestPath];
    if (!entry) return null;
    const [filename, contentType] = entry;
    const full = join(dir, filename);
    if (!existsSync(full)) return null;
    return { body: readFileSync(full, 'utf8'), contentType };
  };
}

/** The panel page itself, served at GET /. Throws if missing — the panel is unusable without it. */
export function readIndexHtml(dir: string = __dirname): string {
  const full = join(dir, INDEX_FILE);
  if (!existsSync(full)) {
    throw new Error(`Sweep Control Panel page not found at ${full} — the ui/ folder is incomplete.`);
  }
  return readFileSync(full, 'utf8');
}
