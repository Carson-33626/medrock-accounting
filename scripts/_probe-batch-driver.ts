/**
 * READ-ONLY: is there a compounding-BATCH grain that could drive an in-lab consumable
 * (syringes for wetting agents), the way fills drive dispensed containers?
 *
 * Run from web/:  npx tsx scripts/_probe-batch-driver.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface KeyRow { k: string }
interface CountRow { location: string | null; month: string | null; n: string }

async function main(): Promise<void> {
  const pool = getRdsPool();

  for (const table of ['lot_production_list', 'compound_log_filled']) {
    const { rows } = await pool.query<KeyRow>(
      `SELECT DISTINCT jsonb_object_keys(row_data) AS k FROM source."${table}" LIMIT 400`,
    );
    console.log(`\n===== source.${table} keys =====`);
    console.log(rows.map((r) => r.k).sort().join(' | '));
  }

  // Batches per month/location from lot_production_list, if it has a date + location.
  const { rows } = await pool.query<CountRow>(
    `SELECT row_data->>'Location' AS location,
            to_char(NULLIF(row_data->>'Lot Created','')::timestamp, 'YYYY-MM') AS month,
            count(*)::text AS n
     FROM source."lot_production_list"
     WHERE to_char(NULLIF(row_data->>'Lot Created','')::timestamp, 'YYYY-MM') >= '2026-01'
     GROUP BY 1, 2 ORDER BY 2, 1`,
  ).catch((): { rows: CountRow[] } => ({ rows: [] }));
  console.log('\n===== lot_production_list batches per month (2026) =====');
  for (const r of rows) console.log(`${r.month}  ${(r.location ?? '').padEnd(14)} ${r.n}`);

  await pool.end();
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
