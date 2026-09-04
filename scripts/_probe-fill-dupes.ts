/**
 * READ-ONLY probe: is a "fill" really one dispense?
 *
 * The device fill query counts one row per `row_data->>'ID'`. If a reprint, a
 * re-label or a multi-line order produces a SECOND ID for the same physical
 * dispense, every device unit count is inflated at the source. Checks ID against
 * Fill Id / Rx Number / Order ID, and looks at the non-completed bins.
 *
 * Run from web/:  npx tsx scripts/_probe-fill-dupes.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface CountRow { readonly label: string; readonly n: string }
interface DupRow { readonly k: string; readonly n: string; readonly items: string }

const BASE = `
  WITH d2 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Date Filled' AS filled, row_data->>'Dispensed Item Name' AS item
    FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
  ),
  d1 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Fill Id' AS fillid, row_data->>'Rx Number' AS rx,
           row_data->>'Refill or New' AS refill
    FROM source."lifefile_data_1" ORDER BY row_data->>'ID', id ASC
  ),
  d4 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Label Type' AS label, row_data->>'Order ID' AS orderid,
           row_data->>'Label Printed On' AS printed, row_data->>'Dispensed Quantity' AS qty
    FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
  ),
  f AS (
    SELECT d2.id, d2.item, d1.fillid, d1.rx, d1.refill, d4.orderid, d4.qty, d2.filled
    FROM d2 JOIN d1 ON d1.id = d2.id JOIN d4 ON d4.id = d2.id
    WHERE trim(coalesce(d4.label,'')) = 'Compound'
      AND NULLIF(d2.filled,'') IS NOT NULL
      AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') BETWEEN '2026-01' AND '2026-09'
  )`;

async function main(): Promise<void> {
  const pool = getRdsPool();

  const { rows: counts } = await pool.query<CountRow>(`${BASE}
    SELECT 'rows (= fills counted)' AS label, count(*)::text AS n FROM f
    UNION ALL SELECT 'distinct ID',        count(DISTINCT id)::text FROM f
    UNION ALL SELECT 'distinct Fill Id',   count(DISTINCT fillid)::text FROM f
    UNION ALL SELECT 'distinct Rx Number', count(DISTINCT rx)::text FROM f
    UNION ALL SELECT 'distinct Order ID',  count(DISTINCT orderid)::text FROM f
    UNION ALL SELECT 'distinct (Rx, Date Filled)', count(DISTINCT (rx, filled))::text FROM f
    UNION ALL SELECT 'distinct (Order ID, item)',  count(DISTINCT (orderid, item))::text FROM f
    UNION ALL SELECT 'null/blank Fill Id',  count(*) FILTER (WHERE coalesce(fillid,'') = '')::text FROM f
    UNION ALL SELECT 'null/blank Order ID', count(*) FILTER (WHERE coalesce(orderid,'') = '')::text FROM f`);
  console.log('### fill-grain sanity (2026-01..09, Compound, Date Filled non-null)');
  for (const r of counts) console.log(`  ${r.label.padEnd(30)} ${String(r.n).padStart(9)}`);

  const { rows: dups } = await pool.query<DupRow>(`${BASE}
    SELECT rx || ' @ ' || filled AS k, count(*)::text AS n,
           string_agg(DISTINCT item, ' | ') AS items
    FROM f WHERE coalesce(rx,'') <> ''
    GROUP BY 1 HAVING count(*) > 1
    ORDER BY count(*) DESC LIMIT 15`);
  console.log('\n### same Rx Number + same Date Filled appearing more than once');
  for (const r of dups) console.log(`  x${String(r.n).padStart(3)}  ${r.k}  ${r.items.slice(0, 110)}`);
  if (dups.length === 0) console.log('  (none)');

  const { rows: refill } = await pool.query<CountRow>(`${BASE}
    SELECT coalesce(NULLIF(refill,''),'(blank)') AS label, count(*)::text AS n
    FROM f GROUP BY 1 ORDER BY 2 DESC`);
  console.log('\n### Refill or New');
  for (const r of refill) console.log(`  ${r.label.padEnd(30)} ${String(r.n).padStart(9)}`);

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
