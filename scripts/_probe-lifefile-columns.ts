/**
 * READ-ONLY probe: what columns do the LifeFile Data Mining extracts carry?
 *
 * Purpose: the device fill query filters on Label Type = 'Compound' + a non-null
 * Date Filled. If there is a status / void / reprint dimension in any of the
 * `source.lifefile_data_*` tables, a cancelled or reprinted label could be
 * counted as a fill and inflate every device unit count.
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface KeyRow {
  readonly k: string;
  readonly n: string;
}

interface TblRow {
  readonly table_name: string;
}

async function main(): Promise<void> {
  const pool = getRdsPool();

  const { rows: tables } = await pool.query<TblRow>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'source' AND table_name LIKE 'lifefile%'
      ORDER BY 1`,
  );
  console.log('TABLES:', tables.map((t): string => t.table_name).join(', '));

  for (const t of tables) {
    const { rows } = await pool.query<KeyRow>(
      `SELECT k, count(*)::text AS n
         FROM (SELECT row_data FROM source."${t.table_name}" LIMIT 2000) s,
              LATERAL jsonb_object_keys(s.row_data) AS k
        GROUP BY k ORDER BY k`,
    );
    console.log(`\n=== ${t.table_name} (${rows.length} keys) ===`);
    for (const r of rows) console.log(`  ${r.k}`);
  }

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
