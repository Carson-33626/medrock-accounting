/**
 * AWS RDS (MedDotsPBI) connection pool for server-side inventory queries.
 * The FIFO tables live in RDS (inventory.* schema), built nightly by the
 * MedRock Data Loader — see docs/superpowers/specs/2026-06-11-fifo-inventory-valuation-design.md
 */

import { Pool } from 'pg';

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
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  });

  return pool;
}
