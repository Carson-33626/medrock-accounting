/** READ-ONLY: where does the loader's device-usage output land in RDS? */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema, table_name FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog','information_schema')
       AND (table_name ILIKE '%device%' OR table_name ILIKE '%usage%' OR table_name ILIKE '%packag%')
     ORDER BY 1,2`,
  );
  console.log('device / usage / packaging tables:');
  for (const r of rows) console.log(`  ${r.table_schema}.${r.table_name}`);

  const { rows: inv } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='inventory' ORDER BY 1`,
  );
  console.log('\ninventory schema:');
  for (const r of inv) console.log(`  ${r.table_name}`);

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
