/** READ-ONLY: column list for inventory.purchase_lots. */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface Col { column_name: string; data_type: string }

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<Col>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'inventory' AND table_name = $1 ORDER BY ordinal_position`,
    ['purchase_lots'],
  );
  for (const r of rows) console.log(`${r.column_name.padEnd(34)} ${r.data_type}`);
  await pool.end();
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
