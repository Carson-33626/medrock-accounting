// Side-effect module: load env BEFORE any module that reads process.env at import time.
// .env.vercel overrides .env.local so the QB client id is the one that minted the tokens
// (the .env.vercel ABKhFJ… id — refreshing with .env.local's id yields invalid_grant).
import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env.vercel', override: true });
