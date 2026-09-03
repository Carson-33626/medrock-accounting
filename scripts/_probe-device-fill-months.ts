/** READ-ONLY: how recent are the compound fills device depletion runs on, per location? */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<{ month: string; location: string; fills: number }>(
    `WITH d2 AS (
       SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
              row_data->>'Date Filled' AS filled
       FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
     ),
     d1 AS (
       SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
              row_data->>'Location' AS location
       FROM source."lifefile_data_1" ORDER BY row_data->>'ID', id ASC
     ),
     d4 AS (
       SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
              row_data->>'Label Type' AS label
       FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
     )
     SELECT to_char(NULLIF(d2.filled, '')::timestamp, 'YYYY-MM') AS month,
            CASE WHEN position('TN' in upper(coalesce(d1.location,''))) > 0 THEN 'TN'
                 WHEN position('FL' in upper(coalesce(d1.location,''))) > 0 THEN 'FL'
                 WHEN position('TX' in upper(coalesce(d1.location,''))) > 0 THEN 'TX'
                 ELSE '?' END AS location,
            count(*)::int AS fills
     FROM d2 JOIN d1 ON d1.id = d2.id JOIN d4 ON d4.id = d2.id
     WHERE trim(coalesce(d4.label,'')) = 'Compound' AND NULLIF(d2.filled,'') IS NOT NULL
     GROUP BY 1, 2
     HAVING to_char(NULLIF(d2.filled, '')::timestamp, 'YYYY-MM') >= '2025-10'
     ORDER BY 1 DESC, 2`,
  );
  console.log('compound fills by month/location (2025-10 onward):');
  for (const r of rows) console.log(`  ${r.month}  ${r.location}  ${r.fills}`);
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
