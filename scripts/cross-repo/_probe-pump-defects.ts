/**
 * READ-ONLY probe: quantify the four candidate causes of the pump over-attribution.
 *
 *  (a) rule 27 — the patternless CATCH-ALL that routes ANY leftover Cream/Gel/Lotion
 *      to a Rosacea Pump, at ceil(qty/30) pumps per fill.
 *  (b) dosage forms that cannot be a pump at all (capsules, suspensions, washes,
 *      sticks) reaching a pump rule because a NAME pattern fired first.
 *  (c) ceilDiv inflation — units in excess of fills, and the qty distribution
 *      driving it.
 *  (d) items whose own name says JAR / OINTMENT / TUB but classify to a pump.
 *
 * Plus the units-vs-units denominator: packaging RECEIPTS in RDS
 * `inventory.purchase_lots` for 2026, which is the only place actual purchased
 * UNITS exist (TN is the only entity with packaging lots — see the DS sec.2).
 *
 * Run from web/:  npx tsx scripts/_probe-pump-defects.ts
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
  readonly month: string | null;
  readonly fills: number;
}

interface LotRow {
  readonly location: string | null;
  readonly product_name: string | null;
  readonly units: string | number | null;
  readonly cost: string | number | null;
  readonly first_receipt: string | null;
  readonly last_receipt: string | null;
}

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
         to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') AS month,
         count(*)::int AS fills
  FROM d2 JOIN d1 ON d1.id = d2.id JOIN d4 ON d4.id = d2.id
  WHERE trim(coalesce(d4.label,'')) = 'Compound'
    AND NULLIF(d2.filled,'') IS NOT NULL
    AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') BETWEEN '2026-01' AND '2026-09'
    AND trim(coalesce(d1.bin,'')) NOT IN
        ('Bucket','Deleted','TRANSFERRED  TO PIONEER','TRANSFERRED  TO TN',
         'TRANSFERRED TO FL','Transferred to other pharmacy')
    AND trim(coalesce(d2.presc,'')) NOT IN ('TESTDOC, TESTDOC','TESTPA, TESTPA')
  GROUP BY 1, 2, 3, 4`;

/** 2026 packaging receipts — actual purchased UNITS, where LifeFile receiving has them. */
const LOTS_SQL = `
  SELECT l.location,
         p.product_name,
         sum(p.qty_received)::text AS units,
         sum(p.total_cost)::text   AS cost,
         min(p.receipt_date)::text AS first_receipt,
         max(p.receipt_date)::text AS last_receipt
  FROM inventory.lot_depletion_ledger l
  JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
  WHERE p.qb_category = 'Lab Compound Packaging Inventory'
    AND l.as_of_month = (SELECT max(as_of_month) FROM inventory.lot_depletion_ledger)
    AND COALESCE(l.pre_floor_collapsed, false) = false
    AND p.qty_received > 0
    AND p.receipt_date >= DATE '2026-01-01'
  GROUP BY 1, 2
  ORDER BY 3 DESC`;

const PUMP_DEVICES = new Set<string>(['Rosacea Pump', 'Melasma Pump', 'AK Pump', 'Tret Pump']);
const PRICES: ReadonlyMap<string, number> = new Map<string, number>([
  ['Rosacea Pump|30g', 2.04], ['Rosacea Pump|15g', 1.51], ['Rosacea Pump|45g', 1.84],
  ['Melasma Pump|30g', 2.04], ['Melasma Pump|15g', 1.51], ['Melasma Pump|45g', 1.84],
  ['AK Pump|30/45G', 1.51], ['AK Pump|60G', 1.86], ['AK Pump|15G', 0.79],
  ['Tret Pump|20g', 1.90], ['Tret Pump|45g', 1.90],
]);

/** Forms that physically cannot ship in an airless pump. */
const NON_PUMP_FORMS = new Set<string>([
  'CAPSULE', 'CAPSULES', 'CAP', 'CAPS', 'TABLET', 'TABLETS', 'TAB',
  'SUSP', 'SUSPENSION', 'SOLUTION', 'SOL', 'OIL', 'POWDER', 'STICK',
  'OINTMENT', 'PASTE', 'SUPPOSITORY', 'TROCHE', 'LOLLIPOP', 'SPRAY',
  'SHAMPOO', 'SOAP', 'WASH', 'AEROSOL', 'FOAM', 'PATCH', 'LIQUID',
]);

/** Item names that self-declare a non-pump container. */
const CONTAINER_WORDS = ['JAR', 'TUB ', 'BOTTLE', 'SPRAY', 'WASH', 'SHAMPOO', 'PEN', 'STICK', 'TUBE'];

interface Agg { fills: number; units: number; value: number }
function agg(): Agg { return { fills: 0, units: 0, value: 0 }; }
function bump(a: Agg, fills: number, units: number, price: number): void {
  a.fills += fills; a.units += units; a.value += units * price;
}
function line(label: string, a: Agg): string {
  return `${label.padEnd(52)} ${String(a.fills).padStart(7)} fills  ${String(a.units).padStart(7)} u  $${a.value.toFixed(0).padStart(8)}`;
}

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows: fills } = await pool.query<FillRow>(FILLS_SQL);

  const totalPump = agg();
  const rule27 = agg();
  const badForm = agg();
  const containerWord = agg();
  const ceilExcess = agg();
  const byQtyBand = new Map<string, Agg>();
  const badFormItems = new Map<string, Agg>();
  const rule27Items = new Map<string, Agg>();
  const bigQtyItems = new Map<string, Agg>();
  const pumpByLoc = new Map<string, Agg>();

  for (const row of fills) {
    const location = row.location ?? '';
    if (location === '') continue;
    const item = (row.item ?? '').trim();
    const qty = deriveQty(row.qty);
    const form = deriveForm(item);
    const ruleId = classifyDeviceRule(item, form, qty);
    const res = resolveDevice(ruleId, qty);
    if (!PUMP_DEVICES.has(res.device) || res.unitsPerFill === 0) continue;

    const dkey = `${res.device}|${res.sku}`;
    const price = PRICES.get(dkey) ?? 0;
    const units = res.unitsPerFill * row.fills;

    bump(totalPump, row.fills, units, price);
    const loc = pumpByLoc.get(location) ?? agg();
    bump(loc, row.fills, units, price);
    pumpByLoc.set(location, loc);

    if (ruleId === 27) {
      bump(rule27, row.fills, units, price);
      const it = rule27Items.get(item) ?? agg();
      bump(it, row.fills, units, price);
      rule27Items.set(item, it);
    }
    if (NON_PUMP_FORMS.has(form)) {
      bump(badForm, row.fills, units, price);
      const it = badFormItems.get(`[${form}] ${item}`) ?? agg();
      bump(it, row.fills, units, price);
      badFormItems.set(`[${form}] ${item}`, it);
    }
    const nameU = item.toUpperCase();
    if (CONTAINER_WORDS.some((w): boolean => nameU.includes(w))) {
      bump(containerWord, row.fills, units, price);
    }
    if (res.unitsPerFill > 1) {
      bump(ceilExcess, row.fills, units - row.fills, price);
      const it = bigQtyItems.get(item) ?? agg();
      bump(it, row.fills, units - row.fills, price);
      bigQtyItems.set(item, it);
    }

    const band = qty === null ? 'null'
      : qty <= 15 ? '<=15' : qty <= 30 ? '16-30' : qty <= 45 ? '31-45'
      : qty <= 60 ? '46-60' : qty <= 120 ? '61-120' : qty <= 240 ? '121-240' : '>240';
    const b = byQtyBand.get(band) ?? agg();
    bump(b, row.fills, units, price);
    byQtyBand.set(band, b);
  }

  console.log('### PUMP TOTAL (2026-01..09, loader filters, OTC exclusions omitted — they are 32 fills)');
  console.log(line('all pump devices', totalPump));
  for (const [l, a] of [...pumpByLoc.entries()].sort()) console.log(line(`  ${l}`, a));

  console.log('\n### (a) rule 27 — patternless CATCH-ALL: any leftover CREAM/GEL/LOTION');
  console.log(line('rule 27 share of pump units', rule27));
  console.log(`  = ${((rule27.units / totalPump.units) * 100).toFixed(1)}% of pump units, ` +
    `${((rule27.value / totalPump.value) * 100).toFixed(1)}% of pump value`);
  console.log('  top items:');
  for (const [it, a] of [...rule27Items.entries()].sort((x, y): number => y[1].units - x[1].units).slice(0, 20)) {
    console.log(`    ${String(a.units).padStart(6)} u / ${String(a.fills).padStart(5)} f (${(a.units / a.fills).toFixed(2)} u/f)  ${it}`);
  }

  console.log('\n### (b) dosage forms that cannot be a pump, yet route to one');
  console.log(line('non-pump forms reaching a pump rule', badForm));
  for (const [it, a] of [...badFormItems.entries()].sort((x, y): number => y[1].units - x[1].units).slice(0, 20)) {
    console.log(`    ${String(a.units).padStart(6)} u / ${String(a.fills).padStart(5)} f  ${it}`);
  }

  console.log('\n### (c) ceilDiv inflation — units in EXCESS of fills');
  console.log(line('excess units from multi-unit fills', ceilExcess));
  console.log(`  = ${((ceilExcess.units / totalPump.units) * 100).toFixed(1)}% of pump units`);
  console.log('  pump units by dispensed qty band:');
  for (const [b, a] of [...byQtyBand.entries()]) {
    console.log(`    ${b.padEnd(8)} ${String(a.fills).padStart(7)} fills -> ${String(a.units).padStart(7)} u  (${(a.units / a.fills).toFixed(2)} u/f)`);
  }
  console.log('  biggest excess-unit items:');
  for (const [it, a] of [...bigQtyItems.entries()].sort((x, y): number => y[1].units - x[1].units).slice(0, 15)) {
    console.log(`    +${String(a.units).padStart(6)} u from ${String(a.fills).padStart(5)} f  ${it}`);
  }

  console.log('\n### (d) item names that self-declare a non-pump container');
  console.log(line('container-word items routed to a pump', containerWord));

  console.log('\n### DENOMINATOR — 2026 packaging RECEIPTS in RDS (actual purchased units)');
  const { rows: lots } = await pool.query<LotRow>(LOTS_SQL);
  let pumpRecvUnits = 0;
  let pumpRecvCost = 0;
  for (const r of lots) {
    const name = (r.product_name ?? '').toUpperCase();
    const units = Number(r.units ?? 0);
    const cost = Number(r.cost ?? 0);
    const isPump = name.includes('PUMP') && !name.includes('FOAM');
    if (isPump) { pumpRecvUnits += units; pumpRecvCost += cost; }
    console.log(
      `  ${isPump ? 'PUMP ' : '     '}${(r.location ?? '').padEnd(20)} ${String(Math.round(units)).padStart(7)} u  ` +
      `$${cost.toFixed(2).padStart(10)}  ${r.first_receipt}..${r.last_receipt}  ${r.product_name}`,
    );
  }
  console.log(`\n  2026 PUMP units RECEIVED into LifeFile: ${Math.round(pumpRecvUnits)}  ($${pumpRecvCost.toFixed(2)})`);

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
