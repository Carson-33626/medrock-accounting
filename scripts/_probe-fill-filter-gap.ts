// READ-ONLY: how much does my indicative fill query overstate against the loader's filters?
// The pricing worksheet's unit counts came from a query WITHOUT the loader's excluded bins,
// test prescribers and OTC name exclusions. If those matter, the modelled consumption is
// biased high and the 123%-of-spend ratio is partly my measurement, not the prices.
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

const BASE = `
  WITH d2 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Date Filled' AS filled,
           row_data->>'Dispensed Item Name' AS item,
           row_data->>'Prescriber Full Name' AS presc
    FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
  ),
  d1 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Location' AS location, row_data->>'Current Bin' AS bin
    FROM source."lifefile_data_1" ORDER BY row_data->>'ID', id ASC
  ),
  d4 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Label Type' AS label
    FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
  ),
  joined AS (
    SELECT d2.id, d2.item, d2.presc, d1.bin,
           CASE WHEN position('TN' in upper(coalesce(d1.location,''))) > 0 THEN 'TN'
                WHEN position('FL' in upper(coalesce(d1.location,''))) > 0 THEN 'FL'
                WHEN position('TX' in upper(coalesce(d1.location,''))) > 0 THEN 'TX'
                ELSE '?' END AS loc
    FROM d2 JOIN d1 ON d1.id = d2.id JOIN d4 ON d4.id = d2.id
    WHERE trim(coalesce(d4.label,'')) = 'Compound'
      AND NULLIF(d2.filled,'') IS NOT NULL
      AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') >= '2026-01'
  )`;

const EXCLUDED_BINS = [
  'Bucket', 'Deleted', 'TRANSFERRED  TO PIONEER',
  'TRANSFERRED  TO TN', 'TRANSFERRED TO FL', 'Transferred to other pharmacy',
];
const TEST_PRESCRIBERS = ['TESTDOC, TESTDOC', 'TESTPA, TESTPA'];

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<{
    loc: string; all_fills: number; bin_dropped: number; presc_dropped: number; kept: number;
  }>(
    `${BASE}
     SELECT loc,
            count(*)::int AS all_fills,
            count(*) FILTER (WHERE trim(coalesce(bin,'')) = ANY($1::text[]))::int AS bin_dropped,
            count(*) FILTER (WHERE trim(coalesce(presc,'')) = ANY($2::text[]))::int AS presc_dropped,
            count(*) FILTER (WHERE trim(coalesce(bin,'')) <> ALL($1::text[])
                               AND trim(coalesce(presc,'')) <> ALL($2::text[]))::int AS kept
     FROM joined GROUP BY loc ORDER BY loc`,
    [EXCLUDED_BINS, TEST_PRESCRIBERS],
  );

  console.log('compound fills 2026-01 onward — my query vs the loader\'s filters\n');
  let a = 0, k = 0;
  for (const r of rows) {
    a += r.all_fills; k += r.kept;
    const pct = r.all_fills === 0 ? 0 : (1 - r.kept / r.all_fills) * 100;
    console.log(
      `  ${r.loc}  all ${String(r.all_fills).padStart(7)}  bin-dropped ${String(r.bin_dropped).padStart(6)}` +
      `  test-presc ${String(r.presc_dropped).padStart(5)}  kept ${String(r.kept).padStart(7)}  overstated ${pct.toFixed(1)}%`);
  }
  console.log(`\n  TOTAL all ${a.toLocaleString()}  kept ${k.toLocaleString()}  overstatement ${((1 - k / a) * 100).toFixed(1)}%`);

  const { rows: bins } = await pool.query<{ bin: string; fills: number }>(
    `${BASE} SELECT trim(coalesce(bin,'(none)')) AS bin, count(*)::int AS fills
     FROM joined WHERE trim(coalesce(bin,'')) = ANY($1::text[]) GROUP BY 1 ORDER BY 2 DESC`,
    [EXCLUDED_BINS]);
  console.log('\n  which bins:');
  for (const b of bins) console.log(`    ${b.bin.padEnd(34)} ${b.fills}`);
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
