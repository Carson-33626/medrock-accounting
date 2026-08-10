// Side-effect module: load env BEFORE any module that reads process.env at import time.
//
// Resolved from __dirname, not cwd, so it finds the program's .env no matter where a runner is
// invoked from. web/.env.local is still read as a FALLBACK during the migration — once the
// program is standalone (Task 8) that file may not exist, and dotenv silently ignores a missing
// path, so no cleanup is required when it goes away.
//
// .env.vercel overrides .env.local so the QB client id is the one that minted the tokens (the
// .env.vercel ABKhFJ… id — refreshing with .env.local's id yields invalid_grant). The program's
// own .env wins over both.
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROGRAM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

config({ path: resolve(PROGRAM_ROOT, '../../.env.local') });
config({ path: resolve(PROGRAM_ROOT, '../../.env.vercel'), override: true });
config({ path: resolve(PROGRAM_ROOT, '.env'), override: true });
