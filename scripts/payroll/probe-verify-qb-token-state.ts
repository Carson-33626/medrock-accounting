/**
 * READ-ONLY diagnostic: current state of accounting_quickbooks_tokens. Reads metadata only
 * (location, realm, expiry, updated_at) — never the token values, and never calls Intuit, so it
 * cannot trigger a refresh. Used to check whether a probe run rotated or invalidated a
 * connection.
 *   npx tsx scripts/payroll/probe-verify-qb-token-state.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface TokenRow {
  location: string;
  realm_id: string | null;
  company_name: string | null;
  expires_at: string | null;
  updated_at: string | null;
  access_token: string | null;
  refresh_token: string | null;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase url/service key not found in .env.vercel');
  const supabase = createClient(url, key);

  const { data, error } = await supabase
    .from('accounting_quickbooks_tokens')
    .select('location, realm_id, company_name, expires_at, updated_at, access_token, refresh_token');
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as TokenRow[];
  console.log(`accounting_quickbooks_tokens rows: ${rows.length}\n`);
  for (const r of rows.sort((a, b) => a.location.localeCompare(b.location))) {
    const exp = r.expires_at ? new Date(r.expires_at) : null;
    const mins = exp ? Math.round((exp.getTime() - Date.now()) / 60000) : null;
    console.log(`  ${r.location.padEnd(14)} realm=${String(r.realm_id).padEnd(20)} company=${String(r.company_name).padEnd(26)}`);
    console.log(`    expires_at=${r.expires_at}  (${mins === null ? '?' : `${mins} min from now`})`);
    console.log(`    updated_at=${r.updated_at}`);
    console.log(`    access_token len=${r.access_token?.length ?? 0}  refresh_token len=${r.refresh_token?.length ?? 0}`);
  }
  console.log(`\nnow = ${new Date().toISOString()}`);
  console.log(`QB client id in env (first 12 chars) = ${String(process.env.QUICKBOOKS_CLIENT_ID ?? process.env.QB_CLIENT_ID ?? '(unset)').slice(0, 12)}…`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
