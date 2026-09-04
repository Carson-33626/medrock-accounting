/**
 * READ-ONLY probe: reconcile the device classifier's PUMP attribution.
 *
 * ds-device-standard-cost-2026-09-03.md sec.11 measures 212,018 pump units modelled
 * against ~$200k of pump-vendor spend (195%). `Rosacea Pump 30g` alone is 101,421
 * units = 35% of all 2026 compound fills. This probe asks WHICH RULE produces
 * those units, what items route there, and how much of the unit count comes from
 * the ceilDiv() unit-per-fill multiplier rather than from fills.
 *
 * Imports the loader's own rules across repos — same pattern as
 * probe-device-pricing-sheet.ts — so this is the classification production uses.
 *
 * Run from web/:  npx tsx scripts/_probe-pump-attribution.ts
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import {
  DEVICE_RULES,
  classifyDeviceRule,
  deriveForm,
  deriveQty,
  resolveCompanion,
  resolveDevice,
} from '../../../../MedRock-Data-Loader/powerbi-sqlite/src/transforms/fifo/devices';

interface FillRow {
  readonly item: string | null;
  readonly qty: string | null;
  readonly location: string | null;
  readonly month: string | null;
  readonly bin: string | null;
  readonly fills: number;
}

/**
 * The loader's DEVICE_FILLS_SQL, with `Current Bin` added to the projection so
 * the bin dimension can be inspected. Filters are otherwise IDENTICAL: Label
 * Type = Compound, non-null Date Filled, excluded bins, test prescribers, OTC.
 */
const FILLS_SQL = `
  WITH d2 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Date Filled' AS filled,
           row_data->>'Dispensed Item Name' AS item,
           row_data->>'Prescriber Full Name' AS presc
    FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
  ),
  d1 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Location' AS location,
           row_data->>'Current Bin' AS bin
    FROM source."lifefile_data_1" ORDER BY row_data->>'ID', id ASC
  ),
  d4 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Label Type' AS label,
           row_data->>'Dispensed Quantity' AS qty
    FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
  )
  SELECT d2.item,
         d4.qty,
         CASE WHEN position('TN' in upper(coalesce(d1.location,''))) > 0 THEN 'MedRock Tennessee'
              WHEN position('FL' in upper(coalesce(d1.location,''))) > 0 THEN 'MedRock Florida'
              WHEN position('TX' in upper(coalesce(d1.location,''))) > 0 THEN 'MedRock Texas'
              ELSE '' END AS location,
         to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') AS month,
         trim(coalesce(d1.bin,'')) AS bin,
         count(*)::int AS fills
  FROM d2 JOIN d1 ON d1.id = d2.id JOIN d4 ON d4.id = d2.id
  WHERE trim(coalesce(d4.label,'')) = 'Compound'
    AND NULLIF(d2.filled,'') IS NOT NULL
    AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') >= $1
    AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') <= $2
    AND trim(coalesce(d1.bin,'')) NOT IN
        ('Bucket','Deleted','TRANSFERRED  TO PIONEER','TRANSFERRED  TO TN',
         'TRANSFERRED TO FL','Transferred to other pharmacy')
    AND trim(coalesce(d2.presc,'')) NOT IN ('TESTDOC, TESTDOC','TESTPA, TESTPA')
    AND trim(coalesce(d2.item,'')) <> 'CeraVe Moisturizing Lotion 0 Lotion'
    AND position('MedRock Comb' in trim(coalesce(d2.item,''))) = 0
    AND position('Hydrocortisone Plus 1% Cream 1% Cream' in trim(coalesce(d2.item,''))) = 0
    AND position('Hydrocortisone 1% Cream 1% Cream' in trim(coalesce(d2.item,''))) = 0
    AND position('HYDROCORTISONE CREAM 1% WITH ALOE  Cream' in trim(coalesce(d2.item,''))) = 0
    AND position('Carmex Lip Balm  Stick' in trim(coalesce(d2.item,''))) = 0
    AND position('Aquaphor Lip Protectant +Sunscreen  Miscellaneous Unspecified' in trim(coalesce(d2.item,''))) = 0
  GROUP BY 1, 2, 3, 4, 5`;

const FROM_MONTH = '2026-01';
const TO_MONTH = '2026-09';

/** Prices from docs/fifo-monthly-close/device-pricing-filled-2026-09-03.csv. */
const PRICES: ReadonlyMap<string, number> = new Map<string, number>([
  ['Rosacea Pump|30g', 2.04], ['Rosacea Pump|15g', 1.51], ['Rosacea Pump|45g', 1.84],
  ['Melasma Pump|30g', 2.04], ['Melasma Pump|15g', 1.51], ['Melasma Pump|45g', 1.84],
  ['AK Pump|30/45G', 1.51], ['AK Pump|60G', 1.86], ['AK Pump|15G', 0.79],
  ['Tret Pump|20g', 1.90], ['Tret Pump|45g', 1.90],
  ['Amber Drop Bottle|1oz dropper', 0.68], ['Wart Pen|', 1.23],
  ['Lip Gloss Tube|', 1.13], ['Eye Pad Pack|', 0.18], ['Nail Brush Bottle|', 0.64],
  ['Ointment Jar|2oz', 0.43], ['Ointment Jar|4oz', 0.48], ['Ointment Jar|10oz', 0.92],
  ['Vial (30DR)|30DR', 0.27], ['Suspension Bottle|', 0.90], ['Syringes|10mL airless', 3.01],
  ['Foam Pump|', 1.40], ['Roller Bottle|', 1.19], ['White & Silver Jar|', 1.87],
]);

const PUMP_DEVICES = new Set<string>(['Rosacea Pump', 'Melasma Pump', 'AK Pump', 'Tret Pump', 'Foam Pump']);

interface Bucket {
  fills: number;
  units: number;
  /** item -> {fills, units} for the top-item listing. */
  items: Map<string, { fills: number; units: number }>;
  /** unitsPerFill -> fills, to expose the ceilDiv multiplier. */
  upf: Map<number, number>;
}

function bucket(): Bucket {
  return { fills: 0, units: 0, items: new Map(), upf: new Map() };
}

function add(b: Bucket, item: string, fills: number, unitsPerFill: number): void {
  const units = fills * unitsPerFill;
  b.fills += fills;
  b.units += units;
  const cur = b.items.get(item) ?? { fills: 0, units: 0 };
  cur.fills += fills;
  cur.units += units;
  b.items.set(item, cur);
  b.upf.set(unitsPerFill, (b.upf.get(unitsPerFill) ?? 0) + fills);
}

function topItems(b: Bucket, n: number): Array<[string, { fills: number; units: number }]> {
  return [...b.items.entries()].sort((a, c): number => c[1].units - a[1].units).slice(0, n);
}

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows: fills } = await pool.query<FillRow>(FILLS_SQL, [FROM_MONTH, TO_MONTH]);

  let totalFills = 0;
  let unmappedFills = 0;
  // ruleId -> device|sku -> Bucket
  const byRule = new Map<number, Map<string, Bucket>>();
  // device|sku -> ruleId -> Bucket   (the reverse view: who feeds Rosacea Pump 30g)
  const byDevice = new Map<string, Map<number, Bucket>>();
  const binCounts = new Map<string, number>();

  for (const row of fills) {
    const location = row.location ?? '';
    if (location === '') continue;
    const item = (row.item ?? '').trim();
    const qty = deriveQty(row.qty);
    totalFills += row.fills;
    binCounts.set(row.bin ?? '', (binCounts.get(row.bin ?? '') ?? 0) + row.fills);

    const ruleId = classifyDeviceRule(item, deriveForm(item), qty);
    const res = resolveDevice(ruleId, qty);
    if (res.device === 'Unmapped' || res.unitsPerFill === 0) {
      unmappedFills += row.fills;
      continue;
    }

    const parts: Array<{ device: string; sku: string; upf: number; rid: number }> = [
      { device: res.device, sku: res.sku, upf: res.unitsPerFill, rid: ruleId },
    ];
    const companion = resolveCompanion(ruleId, qty);
    if (companion !== null) {
      parts.push({ device: companion.device, sku: '', upf: companion.unitsPerFill, rid: ruleId });
    }

    for (const p of parts) {
      const dkey = `${p.device}|${p.sku}`;
      const rmap = byRule.get(p.rid) ?? new Map<string, Bucket>();
      const rb = rmap.get(dkey) ?? bucket();
      add(rb, item, row.fills, p.upf);
      rmap.set(dkey, rb);
      byRule.set(p.rid, rmap);

      const dmap = byDevice.get(dkey) ?? new Map<number, Bucket>();
      const db = dmap.get(p.rid) ?? bucket();
      add(db, item, row.fills, p.upf);
      dmap.set(p.rid, db);
      byDevice.set(dkey, dmap);
    }
  }

  console.log(`### 2026-01..${TO_MONTH} compound fills (loader filters applied)`);
  console.log(`total fills: ${totalFills}   unmapped: ${unmappedFills}\n`);

  console.log('### BINS (fills by Current Bin, after the loader exclusions)');
  for (const [b, n] of [...binCounts.entries()].sort((a, c): number => c[1] - a[1])) {
    console.log(`  ${String(n).padStart(7)}  ${b === '' ? '(blank)' : b}`);
  }

  console.log('\n### BY RULE — units, value, and the ceilDiv multiplier');
  console.log('rule | device|sku | fills | units | units/fill | $ | confidence | patternless?');
  const ruleRows: Array<{ rid: number; dkey: string; b: Bucket; value: number }> = [];
  for (const [rid, rmap] of byRule) {
    for (const [dkey, b] of rmap) {
      ruleRows.push({ rid, dkey, b, value: b.units * (PRICES.get(dkey) ?? 0) });
    }
  }
  ruleRows.sort((a, c): number => c.value - a.value);
  for (const r of ruleRows) {
    const rule = DEVICE_RULES.find((x): boolean => x.id === r.rid);
    const patternless = rule !== undefined
      && (rule.patterns ?? []).length === 0 && (rule.boundedPatterns ?? []).length === 0;
    console.log(
      `${String(r.rid).padStart(4)} | ${r.dkey.padEnd(28)} | ${String(r.b.fills).padStart(7)} | ` +
      `${String(r.b.units).padStart(7)} | ${(r.b.units / Math.max(r.b.fills, 1)).toFixed(3)} | ` +
      `${r.value.toFixed(0).padStart(8)} | ${rule?.confidence ?? '?'} | ${patternless ? 'CATCH-ALL' : ''}`,
    );
  }

  console.log('\n### PUMP TOTALS');
  let pumpUnits = 0;
  let pumpValue = 0;
  for (const r of ruleRows) {
    const device = r.dkey.split('|')[0] ?? '';
    if (!PUMP_DEVICES.has(device)) continue;
    pumpUnits += r.b.units;
    pumpValue += r.value;
  }
  console.log(`pump units ${pumpUnits}   pump $ ${pumpValue.toFixed(0)}`);

  console.log('\n### THE BIG DEVICE ROWS — which rules feed them, and top items');
  const focus = ['Rosacea Pump|30g', 'AK Pump|30/45G', 'Melasma Pump|30g', 'Melasma Pump|15g', 'Rosacea Pump|15g'];
  for (const dkey of focus) {
    const dmap = byDevice.get(dkey);
    if (dmap === undefined) continue;
    const totU = [...dmap.values()].reduce((s, b): number => s + b.units, 0);
    console.log(`\n--- ${dkey}  total units ${totU} ---`);
    for (const [rid, b] of [...dmap.entries()].sort((a, c): number => c[1].units - a[1].units)) {
      const rule = DEVICE_RULES.find((x): boolean => x.id === rid);
      const patternless = rule !== undefined
        && (rule.patterns ?? []).length === 0 && (rule.boundedPatterns ?? []).length === 0;
      console.log(
        `  rule ${rid} (${rule?.confidence ?? '?'}${patternless ? ', CATCH-ALL formIn only' : ''}): ` +
        `${b.fills} fills -> ${b.units} units (${((b.units / totU) * 100).toFixed(1)}%)`,
      );
      console.log(`    units/fill spread: ${[...b.upf.entries()].sort((a, c): number => a[0] - c[0])
        .map(([u, f]): string => `${u}x:${f}`).join('  ')}`);
      for (const [item, s] of topItems(b, 12)) {
        console.log(`      ${String(s.units).padStart(6)} u / ${String(s.fills).padStart(6)} f  ${item}`);
      }
    }
  }

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
