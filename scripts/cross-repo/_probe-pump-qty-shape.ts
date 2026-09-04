/**
 * READ-ONLY probe: the dispensed-quantity shape behind the pump over-count, and
 * what the corrected pump unit count would be under each candidate fix.
 *
 * Run from web/:  npx tsx scripts/_probe-pump-qty-shape.ts
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
  readonly item: string | null;
  readonly qty: string | null;
  readonly location: string | null;
  readonly fills: number;
}

const FILLS_SQL = `
  WITH d2 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Date Filled' AS filled, row_data->>'Dispensed Item Name' AS item,
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
           row_data->>'Label Type' AS label, row_data->>'Dispensed Quantity' AS qty
    FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
  )
  SELECT d2.item, d4.qty,
         CASE WHEN position('TN' in upper(coalesce(d1.location,''))) > 0 THEN 'MedRock Tennessee'
              WHEN position('FL' in upper(coalesce(d1.location,''))) > 0 THEN 'MedRock Florida'
              WHEN position('TX' in upper(coalesce(d1.location,''))) > 0 THEN 'MedRock Texas'
              ELSE '' END AS location,
         count(*)::int AS fills
  FROM d2 JOIN d1 ON d1.id = d2.id JOIN d4 ON d4.id = d2.id
  WHERE trim(coalesce(d4.label,'')) = 'Compound'
    AND NULLIF(d2.filled,'') IS NOT NULL
    AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') BETWEEN '2026-01' AND '2026-09'
    AND trim(coalesce(d1.bin,'')) NOT IN
        ('Bucket','Deleted','TRANSFERRED  TO PIONEER','TRANSFERRED  TO TN',
         'TRANSFERRED TO FL','Transferred to other pharmacy')
    AND trim(coalesce(d2.presc,'')) NOT IN ('TESTDOC, TESTDOC','TESTPA, TESTPA')
  GROUP BY 1, 2, 3`;

const PUMP_DEVICES = new Set<string>(['Rosacea Pump', 'Melasma Pump', 'AK Pump', 'Tret Pump']);
const PRICES: ReadonlyMap<string, number> = new Map<string, number>([
  ['Rosacea Pump|30g', 2.04], ['Rosacea Pump|15g', 1.51], ['Rosacea Pump|45g', 1.84],
  ['Melasma Pump|30g', 2.04], ['Melasma Pump|15g', 1.51], ['Melasma Pump|45g', 1.84],
  ['AK Pump|30/45G', 1.51], ['AK Pump|60G', 1.86], ['AK Pump|15G', 0.79],
  ['Tret Pump|20g', 1.90], ['Tret Pump|45g', 1.90],
]);

const NON_PUMP_FORMS = new Set<string>([
  'CAPSULE', 'CAPSULES', 'CAP', 'CAPS', 'TABLET', 'TABLETS', 'TAB', 'SUSP', 'SUSPENSION',
  'SOLUTION', 'SOL', 'OIL', 'POWDER', 'STICK', 'OINTMENT', 'PASTE', 'SUPPOSITORY',
  'TROCHE', 'SPRAY', 'SHAMPOO', 'SOAP', 'WASH', 'AEROSOL', 'PATCH', 'LIQUID',
]);

interface Scenario { units: number; value: number }
const SCENARIOS: readonly string[] = [
  'as-is (production today)',
  'FIX1: drop rule 27 (patternless catch-all)',
  'FIX2: pump rules never fire on a non-pump dosage form',
  'FIX3: cap units-per-fill at 2 (a fill ships at most 2 containers)',
  'FIX1+2+3 combined',
];

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows: fills } = await pool.query<FillRow>(FILLS_SQL);

  const scen: Scenario[] = SCENARIOS.map((): Scenario => ({ units: 0, value: 0 }));
  const qtyHist = new Map<number, number>();
  const dsappearQty = new Map<number, number>();
  const itchQty = new Map<number, number>();
  // Every distinct qty seen on a pump-classified fill, for the >120 tail.
  const bigQtyByItem = new Map<string, Map<number, number>>();

  for (const row of fills) {
    if ((row.location ?? '') === '') continue;
    const item = (row.item ?? '').trim();
    const qty = deriveQty(row.qty);
    const form = deriveForm(item);
    const ruleId = classifyDeviceRule(item, form, qty);
    const res = resolveDevice(ruleId, qty);
    if (!PUMP_DEVICES.has(res.device) || res.unitsPerFill === 0) continue;

    const price = PRICES.get(`${res.device}|${res.sku}`) ?? 0;
    const upf = res.unitsPerFill;
    const isCatchAll = ruleId === 27;
    const isBadForm = NON_PUMP_FORMS.has(form);
    const capped = Math.min(upf, 2);

    const apply = (idx: number, keep: boolean, units: number): void => {
      if (!keep) return;
      scen[idx].units += units * row.fills;
      scen[idx].value += units * row.fills * price;
    };
    apply(0, true, upf);
    apply(1, !isCatchAll, upf);
    apply(2, !isBadForm, upf);
    apply(3, true, capped);
    apply(4, !isCatchAll && !isBadForm, capped);

    if (qty !== null) {
      qtyHist.set(qty, (qtyHist.get(qty) ?? 0) + row.fills);
      if (item.toUpperCase().startsWith('DSAPPEAR')) {
        dsappearQty.set(qty, (dsappearQty.get(qty) ?? 0) + row.fills);
      }
      if (item.toUpperCase().includes('ITCH')) {
        itchQty.set(qty, (itchQty.get(qty) ?? 0) + row.fills);
      }
      if (qty > 120) {
        const m = bigQtyByItem.get(item) ?? new Map<number, number>();
        m.set(qty, (m.get(qty) ?? 0) + row.fills);
        bigQtyByItem.set(item, m);
      }
    }
  }

  console.log('### Corrected pump counts under each candidate fix (2026-01..09)');
  const base = scen[0];
  for (let i = 0; i < SCENARIOS.length; i += 1) {
    console.log(
      `  ${SCENARIOS[i].padEnd(46)} ${String(Math.round(scen[i].units)).padStart(7)} u  ` +
      `$${scen[i].value.toFixed(0).padStart(8)}  (${((scen[i].units / base.units) * 100).toFixed(0)}% of as-is)`,
    );
  }

  console.log('\n### Dispensed-qty histogram on PUMP-classified fills (top 30 values)');
  for (const [q, n] of [...qtyHist.entries()].sort((a, b): number => b[1] - a[1]).slice(0, 30)) {
    console.log(`  qty ${String(q).padStart(6)} : ${String(n).padStart(7)} fills`);
  }

  console.log('\n### DSAPPEAR qty distribution (the single biggest excess-unit item)');
  for (const [q, n] of [...dsappearQty.entries()].sort((a, b): number => b[1] - a[1]).slice(0, 15)) {
    console.log(`  qty ${String(q).padStart(6)} : ${String(n).padStart(7)} fills -> ${Math.max(1, Math.ceil(q / 30))} "pumps" each`);
  }

  console.log('\n### ITCH-RELIEF qty distribution (name says JAR)');
  for (const [q, n] of [...itchQty.entries()].sort((a, b): number => b[1] - a[1]).slice(0, 15)) {
    console.log(`  qty ${String(q).padStart(6)} : ${String(n).padStart(7)} fills -> ${Math.max(1, Math.ceil(q / 30))} "pumps" each`);
  }

  console.log('\n### Items with qty > 120 g on a pump-classified fill (>4 pumps per fill)');
  const ranked = [...bigQtyByItem.entries()]
    .map(([item, m]): { item: string; fills: number; units: number } => {
      let f = 0;
      let u = 0;
      for (const [q, n] of m) { f += n; u += n * Math.max(1, Math.ceil(q / 30)); }
      return { item, fills: f, units: u };
    })
    .sort((a, b): number => b.units - a.units);
  for (const r of ranked.slice(0, 20)) {
    console.log(`  ${String(r.units).padStart(6)} u / ${String(r.fills).padStart(5)} f  ${r.item}`);
  }
  const tailFills = ranked.reduce((s, r): number => s + r.fills, 0);
  const tailUnits = ranked.reduce((s, r): number => s + r.units, 0);
  console.log(`  TOTAL qty>120 tail: ${tailFills} fills -> ${tailUnits} pump units`);

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
