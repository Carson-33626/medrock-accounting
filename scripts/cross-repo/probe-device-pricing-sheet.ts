/**
 * READ-ONLY: the device/SKU pricing worksheet.
 *
 * Carson, 2026-09-03: "for devices, we have cost per unit by reviewing the invoices, we don't
 * have to be perfect about it but we can set price per unit for the different types from the
 * device usage report, using that we can map out how much got used."
 *
 * So: classify compound fills into (device, SKU) exactly the way the loader does — importing its
 * own rules rather than restating them — count the units, and put beside each one whatever unit
 * cost we can already OBSERVE from real purchase lots. What is left blank is what needs a price
 * off an invoice.
 *
 * UNITS HERE ARE INDICATIVE. The loader's own fill query additionally drops test prescribers,
 * excluded bins and a name-exclusion list that are not exported from that module. Close enough
 * to price against; the production run uses the loader's filtered fills.
 *
 * Run from web/:  npx tsx scripts/probe-device-pricing-sheet.ts > device-pricing.csv
 *
 * LOCAL ONLY, and EXCLUDED FROM tsconfig deliberately. It imports the loader's device
 * ruleset across repos (`../../../../MedRock-Data-Loader/...`) so the classification here is
 * the classification production uses, rather than a second copy that can drift. That path
 * exists on a dev box with both repos checked out as siblings and does NOT exist on Vercel,
 * where only `web/` is deployed — including it in the build broke the deploy once already.
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import {
  DEVICE_SKU_MAPPINGS,
  classifyDeviceRule,
  deriveForm,
  deriveQty,
  resolveCompanion,
  resolveDevice,
} from '../../../../MedRock-Data-Loader/powerbi-sqlite/src/transforms/fifo/devices';

interface FillRow {
  item: string | null;
  form: string | null;
  qty: string | null;
  location: string | null;
  month: string | null;
  fills: number;
}

interface LotCostRow {
  location: string;
  product_name: string | null;
  units: number;
  cost: number;
}

/** Every compound fill since `FROM_MONTH`, at the grain the classifier needs. */
const FILLS_SQL = `
  WITH d2 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Date Filled' AS filled,
           row_data->>'Dispensed Item Name' AS item
    FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
  ),
  d1 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Location' AS location
    FROM source."lifefile_data_1" ORDER BY row_data->>'ID', id ASC
  ),
  d4 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Label Type' AS label,
           row_data->>'Dispensed Quantity' AS qty
    FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
  )
  SELECT d2.item,
         d2.item AS form,
         d4.qty,
         CASE WHEN position('TN' in upper(coalesce(d1.location,''))) > 0 THEN 'MedRock Tennessee'
              WHEN position('FL' in upper(coalesce(d1.location,''))) > 0 THEN 'MedRock Florida'
              WHEN position('TX' in upper(coalesce(d1.location,''))) > 0 THEN 'MedRock Texas'
              ELSE '' END AS location,
         to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') AS month,
         count(*)::int AS fills
  FROM d2 JOIN d1 ON d1.id = d2.id JOIN d4 ON d4.id = d2.id
  WHERE trim(coalesce(d4.label,'')) = 'Compound'
    AND NULLIF(d2.filled,'') IS NOT NULL
    AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') >= $1
  GROUP BY 1, 2, 3, 4, 5`;

/** Observed unit cost on packaging lots we DID receive — the price anchor. */
const LOT_COST_SQL = `
  SELECT l.location,
         p.product_name,
         sum(p.qty_received)::float8 AS units,
         sum(p.total_cost)::float8 AS cost
  FROM inventory.lot_depletion_ledger l
  JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
  WHERE p.qb_category = 'Lab Compound Packaging Inventory'
    AND l.as_of_month = (SELECT max(as_of_month) FROM inventory.lot_depletion_ledger)
    AND COALESCE(l.pre_floor_collapsed, false) = false
    AND p.qty_received > 0
  GROUP BY 1, 2`;

const FROM_MONTH = '2026-01';

function csvCell(v: string | number | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const pool = getRdsPool();

  const { rows: lotCosts } = await pool.query<LotCostRow>(LOT_COST_SQL);
  // Product name -> observed $/unit, for the price anchor column.
  const observed = new Map<string, { units: number; cost: number }>();
  for (const r of lotCosts) {
    const key = (r.product_name ?? '').toUpperCase();
    const acc = observed.get(key) ?? { units: 0, cost: 0 };
    acc.units += r.units;
    acc.cost += r.cost;
    observed.set(key, acc);
  }

  const { rows: fills } = await pool.query<FillRow>(FILLS_SQL, [FROM_MONTH]);

  // (device, sku) -> units per location, plus which months contributed.
  interface Cell { units: Map<string, number>; fills: number; examples: Set<string> }
  const grid = new Map<string, Cell>();
  let unmappedFills = 0;

  for (const row of fills) {
    const location = row.location ?? '';
    if (location === '') continue;
    const item = row.item ?? '';
    const qty = deriveQty(row.qty);
    const ruleId = classifyDeviceRule(item, deriveForm(row.form), qty);
    const res = resolveDevice(ruleId, qty);
    if (res.device === 'Unmapped' || res.unitsPerFill === 0) {
      unmappedFills += row.fills;
      continue;
    }

    const parts: Array<{ device: string; sku: string; units: number }> = [
      { device: res.device, sku: res.sku, units: res.unitsPerFill * row.fills },
    ];
    const companion = resolveCompanion(ruleId, qty);
    if (companion) {
      // Companion packs carry no SKU of their own — they are a whole-unit add-on.
      parts.push({
        device: companion.device,
        sku: '',
        units: companion.unitsPerFill * row.fills,
      });
    }

    for (const p of parts) {
      const key = `${p.device}|${p.sku}`;
      const cell = grid.get(key) ?? { units: new Map(), fills: 0, examples: new Set() };
      cell.units.set(location, (cell.units.get(location) ?? 0) + p.units);
      cell.fills += row.fills;
      if (cell.examples.size < 3 && item !== '') cell.examples.add(item);
      grid.set(key, cell);
    }
  }

  // (device, sku) -> the receipt-name fragments purchasing uses for it. EVERY fragment
  // must appear in the uppercased product name, which is the loader's own match rule.
  const mappedFragments = new Map<string, readonly string[]>();
  for (const m of DEVICE_SKU_MAPPINGS) mappedFragments.set(`${m.device}|${m.sku}`, m.nameAll);

  const LOCATIONS = ['MedRock Florida', 'MedRock Tennessee', 'MedRock Texas'];
  const header = [
    'Device', 'SKU',
    ...LOCATIONS.map((l) => `${l.replace('MedRock ', '')} units`),
    'Total units', 'Months', 'Observed $/unit', 'PRICE PER UNIT (fill in)', 'Example item',
  ];
  console.log(header.map(csvCell).join(','));

  const monthsSpanned = new Set(fills.map((f) => f.month ?? '')).size;

  const sorted = [...grid.entries()].sort((a, b) => {
    const tot = (c: Cell): number => [...c.units.values()].reduce((s, v) => s + v, 0);
    return tot(b[1]) - tot(a[1]);
  });

  for (const [key, cell] of sorted) {
    const [device, sku] = key.split('|');
    const perLoc = LOCATIONS.map((l) => Math.round(cell.units.get(l) ?? 0));
    const total = perLoc.reduce((s, v) => s + v, 0);

    // Price anchor: the blended $/unit of every received product this SKU maps to.
    // Blank means we have never received it here — that is the row needing an invoice.
    const fragments = mappedFragments.get(key);
    let anchorUnits = 0;
    let anchorCost = 0;
    if (fragments && fragments.length > 0) {
      for (const [name, obs] of observed) {
        if (!fragments.every((f) => name.includes(f.toUpperCase()))) continue;
        anchorUnits += obs.units;
        anchorCost += obs.cost;
      }
    }
    const anchor = anchorUnits > 0 ? Math.round((anchorCost / anchorUnits) * 100) / 100 : null;

    console.log(
      [
        device, sku,
        ...perLoc,
        total,
        monthsSpanned,
        anchor === null ? '' : anchor.toFixed(2),
        '',
        [...cell.examples][0] ?? '',
      ].map(csvCell).join(','),
    );
  }

  console.error(`\n${sorted.length} (device, SKU) types from ${FROM_MONTH} onward.`);
  console.error(`${unmappedFills} fills classified UNMAPPED — they deplete nothing.`);
  console.error(`${observed.size} distinct packaging products have real receipts to price from.`);
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
