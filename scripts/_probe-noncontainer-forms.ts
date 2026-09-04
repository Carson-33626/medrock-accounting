/**
 * READ-ONLY: how many 2026 fills does each NON_CONTAINER_FORMS entry actually cover?
 *
 * The loader session's fair catch: I described the new form gate as "capsule, tablet or
 * stick", but the constant is CAPSULE, TABLET, STICK, SUPPOSITORY, TROCHE. Suppositories and
 * troches also stop depleting non-vial containers now, and I had not measured them.
 *
 * Run from web/:  npx tsx scripts/_probe-noncontainer-forms.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

const FORMS = ['CAPSULE', 'TABLET', 'STICK', 'SUPPOSITORY', 'TROCHE'] as const;

interface Row {
  form_word: string;
  fills: number;
  distinct_items: number;
  sample: string | null;
}

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<Row>(
    `WITH d2 AS (
       SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
              row_data->>'Date Filled' AS filled,
              row_data->>'Dispensed Item Name' AS item
       FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
     ),
     d4 AS (
       SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
              row_data->>'Label Type' AS label
       FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
     ),
     joined AS (
       SELECT d2.item
       FROM d2 JOIN d4 ON d4.id = d2.id
       WHERE trim(coalesce(d4.label,'')) = 'Compound'
         AND NULLIF(d2.filled,'') IS NOT NULL
         AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') >= '2026-01'
     ),
     f AS (SELECT unnest($1::text[]) AS form_word)
     SELECT f.form_word,
            count(j.item)::int AS fills,
            count(DISTINCT j.item)::int AS distinct_items,
            max(j.item) AS sample
     FROM f LEFT JOIN joined j ON upper(j.item) LIKE '%' || f.form_word || '%'
     GROUP BY f.form_word ORDER BY 2 DESC`,
    [[...FORMS]],
  );

  console.log('2026 compound fills whose dispensed item name carries each form word:\n');
  let total = 0;
  for (const r of rows) {
    total += r.fills;
    console.log(
      `  ${r.form_word.padEnd(13)} ${String(r.fills).padStart(7)} fills  ${String(r.distinct_items).padStart(4)} items` +
        `   e.g. ${(r.sample ?? '—').slice(0, 54)}`,
    );
  }
  console.log(`\n  total ${total} (overlapping — an item can carry two words)`);
  console.log(
    '\n  Note: the classifier gates on the FORM field, not the item name; this is an\n' +
      '  upper bound on affected fills, measured on the name because the form is derived.',
  );
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
