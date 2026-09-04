/**
 * READ-ONLY probe: (1) packaging receipt history by year — is there ANY purchased-unit
 * denominator in RDS at all; (2) the silverPump 60 g asymmetry against akPump;
 * (3) the corrected pump unit count under the full fix set.
 *
 * Run from web/:  npx tsx scripts/_probe-pump-final.ts
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import {
  classifyDeviceRule,
  deriveForm,
  deriveQty,
  resolveDevice,
} from '../../../../MedRock-Data-Loader/powerbi-sqlite/src/transforms/fifo/devices';

interface YearRow {
  readonly y: string | null;
  readonly loc: string | null;
  readonly n: string | null;
  readonly u: string | null;
  readonly c: string | null;
}
interface PumpLotRow {
  readonly y: string | null;
  readonly loc: string | null;
  readonly pn: string | null;
  readonly u: string | null;
  readonly c: string | null;
}
interface FillRow {
  readonly item: string | null;
  readonly qty: string | null;
  readonly location: string | null;
  readonly fills: number;
}

const YEAR_SQL = `
  SELECT to_char(date_received,'YYYY') AS y, location AS loc, count(*)::text AS n,
         sum(qty_received)::text AS u, sum(total_cost)::text AS c
  FROM inventory.purchase_lots
  WHERE qb_category = 'Lab Compound Packaging Inventory' AND qty_received > 0
  GROUP BY 1,2 ORDER BY 1 DESC, 2`;

const PUMPLOT_SQL = `
  SELECT to_char(date_received,'YYYY') AS y, location AS loc, product_name AS pn,
         sum(qty_received)::text AS u, sum(total_cost)::text AS c
  FROM inventory.purchase_lots
  WHERE qb_category = 'Lab Compound Packaging Inventory' AND qty_received > 0
    AND upper(product_name) LIKE '%PUMP%'
  GROUP BY 1,2,3 ORDER BY 1 DESC, 4 DESC`;

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

const SILVER_RULES = new Set<number>([11, 12, 13, 14, 19, 20, 27]);
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

async function main(): Promise<void> {
  const pool = getRdsPool();

  const { rows: years } = await pool.query<YearRow>(YEAR_SQL);
  console.log('### inventory.purchase_lots — packaging receipts by year/location');
  for (const r of years) {
    console.log(`  ${r.y} ${(r.loc ?? '').padEnd(20)} ${String(r.n).padStart(5)} lots ` +
      `${String(Math.round(Number(r.u ?? 0))).padStart(8)} u  $${Number(r.c ?? 0).toFixed(2)}`);
  }

  const { rows: pl } = await pool.query<PumpLotRow>(PUMPLOT_SQL);
  console.log('\n### PUMP receipts ever recorded in LifeFile receiving');
  let plU = 0;
  let plC = 0;
  for (const r of pl) {
    const u = Number(r.u ?? 0);
    const c = Number(r.c ?? 0);
    plU += u;
    plC += c;
    console.log(`  ${r.y} ${(r.loc ?? '').padEnd(20)} ${String(Math.round(u)).padStart(8)} u ` +
      `$${c.toFixed(2).padStart(10)}  ${r.pn}`);
  }
  console.log(`  TOTAL ${Math.round(plU)} units, $${plC.toFixed(2)}` +
    (plU > 0 ? ` = $${(plC / plU).toFixed(4)}/unit` : ''));

  const { rows: fills } = await pool.query<FillRow>(FILLS_SQL);

  let asIs = 0;
  let asIsVal = 0;
  let silver60Fills = 0;
  let silver60UnitsAsIs = 0;
  let ak60Fills = 0;
  let fixed = 0;
  let fixedVal = 0;
  const perLocAsIs = new Map<string, number>();
  const perLocFixed = new Map<string, number>();

  for (const row of fills) {
    const location = row.location ?? '';
    if (location === '') continue;
    const item = (row.item ?? '').trim();
    const qty = deriveQty(row.qty);
    const form = deriveForm(item);
    const ruleId = classifyDeviceRule(item, form, qty);
    const res = resolveDevice(ruleId, qty);
    if (!PUMP_DEVICES.has(res.device) || res.unitsPerFill === 0) continue;
    const price = PRICES.get(`${res.device}|${res.sku}`) ?? 0;

    asIs += res.unitsPerFill * row.fills;
    asIsVal += res.unitsPerFill * row.fills * price;
    perLocAsIs.set(location, (perLocAsIs.get(location) ?? 0) + res.unitsPerFill * row.fills);

    if (SILVER_RULES.has(ruleId) && qty !== null && qty > 45 && qty <= 60) {
      silver60Fills += row.fills;
      silver60UnitsAsIs += res.unitsPerFill * row.fills;
    }
    if (ruleId === 21 && qty !== null && qty > 45 && qty <= 60) ak60Fills += row.fills;

    // FULL FIX: drop the patternless catch-all, refuse non-pump dosage forms,
    // give silverPump a 60 g SKU (parity with akPump), cap the rest at 2 units.
    if (ruleId === 27) continue;
    if (NON_PUMP_FORMS.has(form)) continue;
    let upf = res.unitsPerFill;
    if (SILVER_RULES.has(ruleId) && qty !== null && qty > 45 && qty <= 60) upf = 1;
    upf = Math.min(upf, 2);
    fixed += upf * row.fills;
    fixedVal += upf * row.fills * price;
    perLocFixed.set(location, (perLocFixed.get(location) ?? 0) + upf * row.fills);
  }

  console.log('\n### The silverPump 60 g asymmetry');
  console.log(`  akPump  (rule 21) fills at 46-60 g: ${ak60Fills} -> 1 unit each (60G SKU exists)`);
  console.log(`  silverPump fills at 46-60 g:        ${silver60Fills} -> ${silver60UnitsAsIs} units ` +
    `(no 60 g SKU, so ceil(q/30) = 2 each)`);
  console.log(`  excess if a 60 g silver pump exists: ${silver60UnitsAsIs - silver60Fills} units`);

  console.log('\n### Pump units: as-is vs fully corrected');
  console.log(`  as-is    ${Math.round(asIs)} units  $${asIsVal.toFixed(0)}`);
  console.log(`  corrected ${Math.round(fixed)} units  $${fixedVal.toFixed(0)}  ` +
    `(${((fixed / asIs) * 100).toFixed(0)}% of as-is)`);
  for (const loc of [...perLocAsIs.keys()].sort()) {
    console.log(`    ${loc.padEnd(20)} ${String(Math.round(perLocAsIs.get(loc) ?? 0)).padStart(7)} -> ` +
      `${String(Math.round(perLocFixed.get(loc) ?? 0)).padStart(7)}`);
  }

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
