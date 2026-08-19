/**
 * Side-effect env loader for scripts that call QuickBooks: .env.vercel FIRST (its
 * QUICKBOOKS_CLIENT_ID is the prod app the stored refresh tokens were minted by —
 * .env.local's is a stale dev app that fails refresh with invalid_client, see the
 * qb-oauth-client-id-gotcha), then .env.local for anything vercel doesn't define.
 * Import this BEFORE any module that reads process.env at module scope
 * (quickbooks-multi.ts captures its creds into top-level constants).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const envFile of ['.env.vercel', '.env.local']) {
  const envText = readFileSync(resolve(__dirname, '..', '..', envFile), 'utf-8');
  for (const line of envText.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
