/** READ-ONLY: what LifeFile source tables exist, and do any carry a formula/component grain? */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface T { table_name: string; n: string }

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<T>(
    `SELECT c.relname AS table_name, to_char(c.reltuples, 'FM999999999') AS n
     FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'source' AND c.relkind = 'r'
     ORDER BY c.relname`,
  );
  for (const r of rows) console.log(`${r.table_name.padEnd(46)} ~${r.n}`);
  await pool.end();
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
