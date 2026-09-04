/**
 * READ-ONLY probe: does the CODE match the v2 SPEC, and what did v1 route differently?
 *
 * `devices.ts` states "Rule ids match docs/device-usage/device-mapping-v2.csv 1:1".
 * The v2 CSV column `units_per_fill` reads **1** for every pump rule (5, 11-15, 19-21).
 * Only rule 27 carries a multiplier, and it is bounded: "qty<=45 -> 1; 60g -> 2".
 * `resolveDevice`'s `silverPump` / `akPump` branches apply an UNBOUNDED ceilDiv to all
 * of them. This measures the divergence.
 *
 * It also censuses rules that never fire, and compares the population each rule wins
 * against v1's own expected-volume figures (device-mapping-draft.csv `sample_fills`).
 *
 * Run from web/:  npx tsx scripts/_probe-pump-v1-v2-regression.ts
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import {
  DEVICE_RULES,
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

/**
 * `units_per_fill` exactly as device-mapping-v2.csv states it, per rule id.
 * 'one' = the CSV says 1, flat, with no multiplier of any kind.
 */
const SPEC_UNITS: ReadonlyMap<number, 'one' | 'ceil30' | 'rule27'> = new Map<number, 'one' | 'ceil30' | 'rule27'>([
  [1, 'one'], [2, 'one'], [3, 'one'], [4, 'one'], [5, 'one'], [6, 'one'], [7, 'one'],
  [8, 'one'], [9, 'one'], [10, 'one'], [11, 'one'], [12, 'one'], [13, 'one'], [14, 'one'],
  [15, 'one'], [16, 'ceil30'], [17, 'one'], [18, 'one'], [19, 'one'], [20, 'one'],
  [21, 'one'], [22, 'ceil30'], [23, 'one'], [24, 'one'], [25, 'one'], [26, 'one'],
  [27, 'rule27'],
]);

/** v1 device-mapping-draft.csv `sample_fills`, aggregated to the v2 device classes. */
const V1_EXPECTED: ReadonlyMap<string, number> = new Map<string, number>([
  ['AK Pump', 123600 + 50 + 4000],
  ['Syringes', 12600 + 85400 + 23800],
  ['Lip Gloss Tube', 14100],
  ['Foam Pump', 1700],
  ['Amber Drop Bottle', 78400 + 1900 + 44400 + 3300],
  ['Vial (30DR)', 14500],
  ['Tret Pump', 7600],
  ['Rosacea Pump', 71300 + 266000 + 16700 + 43000],
  ['Ointment Jar', 13700 + 10000 + 7500 + 340],
  ['Suspension Bottle', 2000],
]);
const V1_TOTAL = 846430;

const PUMP_DEVICES = new Set<string>(['Rosacea Pump', 'Melasma Pump', 'AK Pump', 'Tret Pump']);
const PRICES: ReadonlyMap<string, number> = new Map<string, number>([
  ['Rosacea Pump|30g', 2.04], ['Rosacea Pump|15g', 1.51], ['Rosacea Pump|45g', 1.84],
  ['Melasma Pump|30g', 2.04], ['Melasma Pump|15g', 1.51], ['Melasma Pump|45g', 1.84],
  ['AK Pump|30/45G', 1.51], ['AK Pump|60G', 1.86], ['AK Pump|15G', 0.79],
  ['Tret Pump|20g', 1.90], ['Tret Pump|45g', 1.90],
]);
const TOPICAL = new Set<string>(['CREAM', 'GEL', 'LOTION']);

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows: fills } = await pool.query<FillRow>(FILLS_SQL);

  const ruleFills = new Map<number, number>();
  const deviceFills = new Map<string, number>();
  let totalFills = 0;

  // Divergence between the code's unitsPerFill and what the v2 CSV states.
  let overFills = 0;
  let overUnits = 0;
  let overValue = 0;
  const overByRule = new Map<number, { fills: number; units: number; value: number }>();

  // v1 rows 20/21/22: CREAM|OINTMENT|LOTION above 120 g went to a JAR, 1 unit.
  let v1JarFills = 0;
  let v1JarPumpUnits = 0;
  let v1JarPumpValue = 0;
  let v1Jar75to120Fills = 0;
  let v1Jar75to120Units = 0;
  let v1Jar75to120Value = 0;

  // Silver-family 30 g population, to compare with v1 row 16.
  let silver30Fills = 0;

  for (const row of fills) {
    if ((row.location ?? '') === '') continue;
    const item = (row.item ?? '').trim();
    const qty = deriveQty(row.qty);
    const form = deriveForm(item);
    const ruleId = classifyDeviceRule(item, form, qty);
    const res = resolveDevice(ruleId, qty);
    totalFills += row.fills;
    ruleFills.set(ruleId, (ruleFills.get(ruleId) ?? 0) + row.fills);
    if (res.device !== 'Unmapped') {
      deviceFills.set(res.device, (deviceFills.get(res.device) ?? 0) + row.fills);
    }
    if (!PUMP_DEVICES.has(res.device) || res.unitsPerFill === 0) continue;
    const price = PRICES.get(`${res.device}|${res.sku}`) ?? 0;

    if ((res.device === 'Rosacea Pump' || res.device === 'Melasma Pump') && res.sku === '30g') {
      silver30Fills += row.fills;
    }

    // What the v2 CSV says this rule consumes.
    const spec = SPEC_UNITS.get(ruleId) ?? 'one';
    const specUnits = spec === 'ceil30' && qty !== null
      ? Math.max(1, Math.ceil(qty / 30))
      : spec === 'rule27'
        ? (qty !== null && qty > 45 && qty <= 60 ? 2 : 1)
        : 1;
    if (res.unitsPerFill > specUnits) {
      const excess = (res.unitsPerFill - specUnits) * row.fills;
      overFills += row.fills;
      overUnits += excess;
      overValue += excess * price;
      const acc = overByRule.get(ruleId) ?? { fills: 0, units: 0, value: 0 };
      acc.fills += row.fills;
      acc.units += excess;
      acc.value += excess * price;
      overByRule.set(ruleId, acc);
    }

    if (TOPICAL.has(form) && qty !== null && qty > 120) {
      v1JarFills += row.fills;
      v1JarPumpUnits += res.unitsPerFill * row.fills;
      v1JarPumpValue += res.unitsPerFill * row.fills * price;
    }
    if (TOPICAL.has(form) && qty !== null && qty > 60 && qty <= 120) {
      v1Jar75to120Fills += row.fills;
      v1Jar75to120Units += res.unitsPerFill * row.fills;
      v1Jar75to120Value += res.unitsPerFill * row.fills * price;
    }
  }

  console.log('### A. CODE vs the v2 SPEC it claims to match 1:1');
  console.log('device-mapping-v2.csv `units_per_fill` is 1 for EVERY pump rule; only rule 27');
  console.log('carries a multiplier and it is bounded ("qty<=45 -> 1; 60g -> 2").');
  console.log(`\n  fills where the code consumed MORE than the CSV states: ${overFills}`);
  console.log(`  excess units: ${overUnits}   excess value: $${overValue.toFixed(0)}`);
  console.log('  by rule:');
  for (const [rid, a] of [...overByRule.entries()].sort((x, y): number => y[1].units - x[1].units)) {
    const rule = DEVICE_RULES.find((r): boolean => r.id === rid);
    console.log(`    rule ${String(rid).padStart(2)} (${rule?.device ?? '?'}, sizing ${rule?.sizing ?? '?'}, ` +
      `CSV says ${SPEC_UNITS.get(rid)}): ${a.fills} fills, +${a.units} units, +$${a.value.toFixed(0)}`);
  }

  console.log('\n### B. v1 sized big CREAMS into JARS; v2 has no such rule');
  console.log('v1 draft row 21: CREAM|OINTMENT|LOTION 121-300 g -> OINT JAR (10 OZ), 1 unit');
  console.log('v1 draft row 20: CREAM|OINTMENT|LOTION  75-120 g -> OINT JAR (4OZ),  1 unit');
  console.log('v2 rules 18/25 are gated formIn OINTMENT|PASTE, so a big CREAM cannot reach a jar.');
  console.log(`\n  topical fills > 120 g now routed to a PUMP: ${v1JarFills} fills -> ` +
    `${v1JarPumpUnits} pump units, $${v1JarPumpValue.toFixed(0)}`);
  console.log(`    v1 would have consumed ${v1JarFills} 10 oz jars @ $0.92 = $${(v1JarFills * 0.92).toFixed(0)}`);
  console.log(`    difference: $${(v1JarPumpValue - v1JarFills * 0.92).toFixed(0)}`);
  console.log(`\n  topical fills 61-120 g now routed to a PUMP: ${v1Jar75to120Fills} fills -> ` +
    `${v1Jar75to120Units} pump units, $${v1Jar75to120Value.toFixed(0)}`);
  console.log(`    v1 would have consumed ${v1Jar75to120Fills} 4 oz jars @ $0.48 = $${(v1Jar75to120Fills * 0.48).toFixed(0)}`);
  console.log(`    difference: $${(v1Jar75to120Value - v1Jar75to120Fills * 0.48).toFixed(0)}`);

  console.log('\n### C. Rules that NEVER fire');
  for (const rule of DEVICE_RULES) {
    const n = ruleFills.get(rule.id) ?? 0;
    if (n === 0) {
      console.log(`  rule ${String(rule.id).padStart(2)} ${rule.device.padEnd(20)} ZERO fills  ` +
        `(patterns: ${(rule.patterns ?? []).join('|') || '-'}; formIn: ${(rule.formIn ?? []).join('|') || '-'})`);
    }
  }
  console.log('  low-volume rules (< 250 fills):');
  for (const rule of DEVICE_RULES) {
    const n = ruleFills.get(rule.id) ?? 0;
    if (n > 0 && n < 250) {
      console.log(`    rule ${String(rule.id).padStart(2)} ${rule.device.padEnd(20)} ${String(n).padStart(6)} fills`);
    }
  }

  console.log('\n### D. Population won per device vs v1 expected share');
  console.log(`  (v1 sample_fills total ${V1_TOTAL} spans a longer window than these ${totalFills} 2026 fills,`);
  console.log('   so compare SHARES, not counts.)');
  console.log('  device                 2026 fills   share    v1 share   ratio');
  for (const [dev, v1n] of [...V1_EXPECTED.entries()].sort((a, b): number => b[1] - a[1])) {
    const actual = dev === 'Rosacea Pump'
      ? (deviceFills.get('Rosacea Pump') ?? 0) + (deviceFills.get('Melasma Pump') ?? 0)
      : (deviceFills.get(dev) ?? 0);
    const aShare = (actual / totalFills) * 100;
    const vShare = (v1n / V1_TOTAL) * 100;
    console.log(`  ${dev.padEnd(22)} ${String(actual).padStart(8)}   ${aShare.toFixed(1).padStart(5)}%   ` +
      `${vShare.toFixed(1).padStart(5)}%   ${(aShare / vShare).toFixed(2)}x`);
  }
  console.log(`\n  silver-family 30 g fills: ${silver30Fills} = ${((silver30Fills / totalFills) * 100).toFixed(1)}% ` +
    `of all fills; v1 row 16 expected ${(266000 / V1_TOTAL * 100).toFixed(1)}%`);

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
