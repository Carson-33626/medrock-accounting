// Side-effect module: load env BEFORE any module that reads process.env at import time.
// .env.vercel overrides .env.local so the QB client id is the one that minted the tokens
// (the .env.vercel ABKhFJ… id — refreshing with .env.local's id yields invalid_grant).
//
// The receipt-enrichment program has its OWN copy pointing at its own .env. These two are
// separate on purpose: this one is for scripts that run from web/.
import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env.vercel', override: true });
