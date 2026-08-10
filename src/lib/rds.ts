/**
 * AWS RDS (MedDotsPBI) connection pool for server-side inventory queries.
 * The FIFO tables live in RDS (inventory.* schema), built nightly by the
 * MedRock Data Loader — see docs/superpowers/specs/2026-06-11-fifo-inventory-valuation-design.md
 */

import { Pool } from 'pg';
import { RDS_SSL } from './rds-ssl';

let pool: Pool | null = null;

export function getRdsPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.RDS_DATABASE_URL;
  if (!connectionString) {
    throw new Error('Missing RDS_DATABASE_URL environment variable');
  }

  pool = new Pool({
    connectionString,
    // Vercel serverless: keep the pool tiny; connections are per-lambda.
    max: 3,
    idleTimeoutMillis: 30_000,
    /**
     * 10s is right for a serverless request — a web request that cannot get a connection should
     * fail fast rather than hold the lambda open. Long-running CLI scripts are the opposite case:
     * `regen-drafts.ts` rebuilds a year of payroll drafts and, when several probes and another
     * session are competing for RDS, it repeatedly died on connection acquisition and left the
     * work half-done. Hence the opt-in override, applied by scripts only — the default, and so
     * production behaviour, is unchanged.
     */
    connectionTimeoutMillis: Number(process.env.RDS_CONNECT_TIMEOUT_MS) || 10_000,
    ssl: RDS_SSL,
  });

  return pool;
}
