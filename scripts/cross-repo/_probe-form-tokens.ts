/**
 * READ-ONLY probe: why rules 9 and 24 never fire.
 *
 * `deriveForm` takes the UPPERCASED LAST WHITESPACE TOKEN of the item name. If the
 * lab writes "Susp/Soap" or "Miscellaneous Unspecified", a rule gated on
 * formIn ['SUSP','SUSPENSION'] can never match. Lists the actual form tokens.
 *
 * Run from web/:  npx tsx scripts/_probe-form-tokens.ts
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import { classifyDeviceRule, deriveForm, deriveQty } from '../../../../MedRock-Data-Loader/powerbi-sqlite/src/transforms/fifo/devices';

interface FillRow {
  readonly item: string | null;
  readonly qty: string | null;
  readonly fills: number;
}

const SQL = `
  WITH d2 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Date Filled' AS filled, row_data->>'Dispensed Item Name' AS item
    FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
  ),
  d4 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Label Type' AS label, row_data->>'Dispensed Quantity' AS qty
    FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
  )
  SELECT d2.item, d4.qty, count(*)::int AS fills
  FROM d2 JOIN d4 ON d4.id = d2.id
  WHERE trim(coalesce(d4.label,'')) = 'Compound'
    AND NULLIF(d2.filled,'') IS NOT NULL
    AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') BETWEEN '2026-01' AND '2026-09'
  GROUP BY 1, 2`;

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<FillRow>(SQL);

  const forms = new Map<string, number>();
  const suspLike = new Map<string, { fills: number; rule: number; example: string }>();
  let drynessV = 0;

  for (const r of rows) {
    const item = (r.item ?? '').trim();
    const form = deriveForm(item);
    const qty = deriveQty(r.qty);
    forms.set(form, (forms.get(form) ?? 0) + r.fills);
    if (/SUSP|SOAP|WASH/.test(form)) {
      const acc = suspLike.get(form) ?? { fills: 0, rule: classifyDeviceRule(item, form, qty), example: item };
      acc.fills += r.fills;
      suspLike.set(form, acc);
    }
    if (item.toUpperCase().includes('DRYNESS V')) drynessV += r.fills;
  }

  console.log('### form tokens (deriveForm = uppercased LAST whitespace token) — top 40');
  for (const [f, n] of [...forms.entries()].sort((a, b): number => b[1] - a[1]).slice(0, 40)) {
    console.log(`  ${String(n).padStart(7)}  ${f === '' ? '(blank)' : f}`);
  }

  console.log('\n### suspension-like form tokens and where they route');
  for (const [f, a] of [...suspLike.entries()].sort((x, y): number => y[1].fills - x[1].fills)) {
    console.log(`  ${String(a.fills).padStart(6)}  form="${f}"  -> rule ${a.rule}   e.g. ${a.example.slice(0, 70)}`);
  }

  console.log(`\n### DRYNESS V fills in 2026: ${drynessV}  (rules 8/9 split on qty 30)`);

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
