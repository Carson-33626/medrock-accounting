/**
 * One-off ops apply: re-seed accounting.payroll_account_map memos via a DIRECT pg Pool
 * (no connectionTimeoutMillis cap — getRdsPool()'s 10s cap trips on the currently-slow RDS
 * handshake). Uses the SAME rules from buildSeedAccountMap and the SAME natural-key upsert SQL
 * as store.upsertAccountRule, so it's byte-identical to the normal seeder path — just a more
 * patient connection. Idempotent: memo is not in the conflict key, so this updates in place.
 *   npx tsx scripts/payroll/apply-memo-seed-direct.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import { POSTABLE_ENTITIES } from '../../src/lib/payroll/entity';
import { buildSeedAccountMap } from './account-map-seed-data';

const UPSERT = `INSERT INTO accounting.payroll_account_map
    (entity, adp_column, cost_center, account_name, posting_type, is_cogs, credit_bucket, active, memo, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
  ON CONFLICT (entity, adp_column, cost_center, posting_type, account_name) DO UPDATE SET
    is_cogs = EXCLUDED.is_cogs,
    credit_bucket = EXCLUDED.credit_bucket,
    active = EXCLUDED.active,
    memo = EXCLUDED.memo,
    updated_at = now()`;

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    keepAlive: true,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    for (const entity of POSTABLE_ENTITIES) {
      const rules = buildSeedAccountMap(entity);
      let count = 0;
      for (const rule of rules) {
        await client.query(UPSERT, [
          rule.entity, rule.adpColumn, rule.costCenter, rule.accountName, rule.postingType,
          rule.isCogs, rule.creditBucket, rule.active, rule.memo ?? null,
        ]);
        count++;
      }
      console.log(`${entity}: upserted ${count} rules`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
