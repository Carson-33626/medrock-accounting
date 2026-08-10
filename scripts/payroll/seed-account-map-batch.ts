/**
 * Batched applier for the payroll account-map seed.
 *
 * WHY THIS EXISTS: seed-account-map.ts upserts one rule per round-trip. At 1,298 rules (four
 * entities, since FOCAS joined) that is 1,298 sequential queries, and against RDS it reliably
 * died partway with "Connection terminated due to connection timeout" — leaving the map in a
 * half-seeded state. This sends the same rules as multi-row INSERT ... ON CONFLICT statements in
 * chunks, which is a couple of dozen queries instead, and retries a dropped connection.
 *
 * Identical semantics to the original: the same buildSeedAccountMap output, the same natural-key
 * conflict target, and the same "update the mutable columns, leave the key alone" behaviour. Safe
 * to re-run — it is idempotent by construction.
 *
 *   npx tsx scripts/payroll/seed-account-map-batch.ts            (dry run: counts only)
 *   npx tsx scripts/payroll/seed-account-map-batch.ts --apply
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import type { AccountMapRule } from '../../src/lib/payroll/types';
import { buildSeedAccountMap, SEEDED_ENTITIES } from './account-map-seed-data';

const APPLY = process.argv.includes('--apply');
/** 9 params per row; Postgres caps a statement at 65535 bound parameters. 400 rows = 3,600. */
const CHUNK = 400;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function upsertChunk(pool: Pool, rules: AccountMapRule[]): Promise<number> {
  const values: string[] = [];
  const params: Array<string | boolean | null> = [];
  rules.forEach((r, i) => {
    const b = i * 9;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},now())`);
    params.push(
      r.entity, r.adpColumn, r.costCenter, r.accountName, r.postingType,
      r.isCogs, r.creditBucket, r.active, r.memo ?? null,
    );
  });

  const sql =
    `INSERT INTO accounting.payroll_account_map
       (entity, adp_column, cost_center, account_name, posting_type, is_cogs, credit_bucket, active, memo, updated_at)
     VALUES ${values.join(',')}
     ON CONFLICT (entity, adp_column, cost_center, posting_type, account_name) DO UPDATE SET
       is_cogs = EXCLUDED.is_cogs,
       credit_bucket = EXCLUDED.credit_bucket,
       active = EXCLUDED.active,
       memo = EXCLUDED.memo,
       updated_at = now()`;

  // One retry on a dropped connection — RDS occasionally closes an idle pooled socket, and the
  // statement is idempotent so replaying it is safe.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await pool.query(sql, params);
      return res.rowCount ?? 0;
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`    (chunk failed, retry ${attempt}/2: ${e instanceof Error ? e.message : String(e)})`);
      await sleep(2000 * attempt);
    }
  }
  return 0;
}

/**
 * Deactivate any OTHER active rule sitting in a slot this seed just claimed.
 *
 * The conflict target includes account_name, so changing a column's account in the seed data
 * INSERTS a new rule and leaves the old one active. `resolveLine` returns every in-direction
 * match, so both then fire and the column posts twice — and the panel shows what looks like a
 * duplicate. That is how MedRock FL ended up with two active ADMIN overtime rules (Barbara's
 * 2026-08-06 report). The seed is the writer that creates them, so the seed cleans up after
 * itself. Mirrors deactivateSupersededAccountRules in src/lib/payroll/store.ts.
 *
 * `preview` counts what WOULD be deactivated without writing, so a dry run reports it.
 */
async function supersedeChunk(pool: Pool, rules: AccountMapRule[], preview: boolean): Promise<number> {
  const live = rules.filter((r) => r.active);
  if (live.length === 0) return 0;

  const values: string[] = [];
  const params: string[] = [];
  live.forEach((r, i) => {
    const b = i * 5;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
    params.push(r.entity, r.adpColumn, r.costCenter, r.postingType, r.accountName);
  });

  const slots = `(VALUES ${values.join(',')}) AS s(entity, adp_column, cost_center, posting_type, account_name)`;
  const predicate =
    `m.entity = s.entity AND m.adp_column = s.adp_column
     AND m.cost_center = s.cost_center AND m.posting_type = s.posting_type
     AND m.account_name <> s.account_name
     AND m.active`;

  if (preview) {
    const res = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT m.id)::text AS n
         FROM accounting.payroll_account_map m
         JOIN ${slots} ON ${predicate}`,
      params,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  const res = await pool.query(
    `UPDATE accounting.payroll_account_map m
        SET active = false, updated_at = now()
       FROM ${slots}
      WHERE ${predicate}`,
    params,
  );
  return res.rowCount ?? 0;
}

async function main(): Promise<void> {
  const byEntity = SEEDED_ENTITIES.map((e) => ({ entity: e, rules: buildSeedAccountMap(e) }));
  const total = byEntity.reduce((s, x) => s + x.rules.length, 0);

  for (const { entity, rules } of byEntity) {
    console.log(`  ${entity.padEnd(12)} ${String(rules.length).padStart(5)} rules`);
  }
  console.log(`  TOTAL ${total}`);

  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 2,
    ssl: RDS_SSL,
    connectionTimeoutMillis: Number(process.env.RDS_CONNECT_TIMEOUT_MS) || 30_000,
    idleTimeoutMillis: 10_000,
  });

  try {
    if (!APPLY) {
      // A dry run still READS, so it can report the one thing that is not obvious from the rule
      // count: how many currently-active rules this seed would supersede.
      let wouldSupersede = 0;
      for (const { rules } of byEntity) {
        for (let i = 0; i < rules.length; i += CHUNK) {
          wouldSupersede += await supersedeChunk(pool, rules.slice(i, i + CHUNK), true);
        }
      }
      console.log(
        `\n${wouldSupersede} existing ACTIVE rule(s) would be superseded (same column + cost centre +` +
        ` direction, different account) and deactivated.`,
      );
      console.log('Dry run only. Re-run with --apply to upsert.');
      return;
    }

    let done = 0;
    for (const { entity, rules } of byEntity) {
      for (let i = 0; i < rules.length; i += CHUNK) {
        const chunk = rules.slice(i, i + CHUNK);
        await upsertChunk(pool, chunk);
        done += chunk.length;
        console.log(`  ${entity}: ${done}/${total}`);
      }
    }
    console.log(`\nUpserted ${done} rules.`);

    // AFTER every chunk is in: a rule inserted late must not be deactivated by an earlier chunk's
    // sweep, so the sweep runs once the full seed is present.
    let superseded = 0;
    for (const { rules } of byEntity) {
      for (let i = 0; i < rules.length; i += CHUNK) {
        superseded += await supersedeChunk(pool, rules.slice(i, i + CHUNK), false);
      }
    }
    console.log(`Deactivated ${superseded} superseded rule(s).`);
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
