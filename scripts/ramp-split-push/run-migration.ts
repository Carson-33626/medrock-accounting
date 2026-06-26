import './load-env';
import { readFileSync } from 'node:fs';
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const sqlPath = process.argv[2];
  if (!sqlPath) throw new Error('Usage: tsx run-migration.ts <path-to-sql>');
  const sql = readFileSync(sqlPath, 'utf8');
  const pool = getRdsPool();
  await pool.query(sql);
  console.log(`Applied migration: ${sqlPath}`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
