/**
 * READ-ONLY: of the fills the restored jar gate now claims, how many are GELS?
 *
 * The data-loader session's catch, and it is correct: v1 rows 20/21 read
 * `CREAM|OINTMENT|LOTION` and `CREAM|OINTMENT|LOTION|PASTE`. Neither contains GEL. The
 * restored rule's `formIn` is `['CREAM','GEL','LOTION','OINTMENT','PASTE']`, so a >=75 g gel
 * routes to a jar on a rule whose cited provenance does not cover gels, and on a ruling
 * ("the 240 definitely go to jar") that was about a cream.
 *
 * This splits the affected population by form so the gel question can be put to Carson on
 * its own evidence rather than riding along inside a cream ruling.
 *
 * Run from web/:  npx tsx scripts/_probe-jar-gel-split.ts
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import {
  classifyDeviceRule,
  deriveForm,
  deriveQty,
  resolveDevice,
} from '../../../../MedRock-Data-Loader/powerbi-sqlite/src/transforms/fifo/devices';

interface FillRow {
  item: string | null;
  qty: string | null;
  fills: number;
}

const FILLS_SQL = `
  WITH d2 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Date Filled' AS filled,
           row_data->>'Dispensed Item Name' AS item
    FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
  ),
  d4 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Label Type' AS label,
           row_data->>'Dispensed Quantity' AS qty
    FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
  )
  SELECT d2.item, d4.qty, count(*)::int AS fills
  FROM d2 JOIN d4 ON d4.id = d2.id
  WHERE trim(coalesce(d4.label,'')) = 'Compound'
    AND NULLIF(d2.filled,'') IS NOT NULL
    AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') >= '2026-01'
  GROUP BY 1, 2`;

const JAR_GATE_RULE_ID = 100;

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<FillRow>(FILLS_SQL);

  interface Bucket { fills: number; units: number; items: Map<string, number> }
  const byForm = new Map<string, Bucket>();

  for (const row of rows) {
    const item = row.item ?? '';
    const qty = deriveQty(row.qty);
    const form = deriveForm(item);
    if (classifyDeviceRule(item, form, qty) !== JAR_GATE_RULE_ID) continue;

    const res = resolveDevice(JAR_GATE_RULE_ID, qty);
    const b = byForm.get(form) ?? { fills: 0, units: 0, items: new Map() };
    b.fills += row.fills;
    b.units += res.unitsPerFill * row.fills;
    b.items.set(item, (b.items.get(item) ?? 0) + row.fills);
    byForm.set(form, b);
  }

  const total = [...byForm.values()].reduce((s, b) => s + b.units, 0);
  console.log('fills the restored jar gate (rule 100) now claims, by FORM:\n');
  for (const [form, b] of [...byForm.entries()].sort((a, b2) => b2[1].units - a[1].units)) {
    const cited = ['CREAM', 'OINTMENT', 'LOTION', 'PASTE'].includes(form);
    console.log(
      `  ${cited ? ' ' : '*'} ${form.padEnd(12)} ${String(b.fills).padStart(6)} fills  ` +
        `${String(b.units).padStart(6)} units  ${(b.units / total * 100).toFixed(1).padStart(5)}%`,
    );
  }
  console.log('\n  * = NOT in v1 rows 20/21, which read CREAM|OINTMENT|LOTION(|PASTE)');

  const gel = byForm.get('GEL');
  if (gel) {
    console.log(`\nGEL detail — ${gel.fills} fills, ${gel.units} units, top items:`);
    for (const [name, n] of [...gel.items.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 12)) {
      console.log(`  ${String(n).padStart(5)}  ${name.slice(0, 66)}`);
    }
  } else {
    console.log('\nNo GEL fills reach the gate at all — the formIn entry is inert.');
  }
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
