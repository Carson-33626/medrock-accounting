/**
 * READ-ONLY, two questions:
 *
 *  A. Tret Pump breadth — Carson: "tret pumps are used in quite a few products as well per the
 *     device rulings." How many DISTINCT dispensed products route to Tret Pump, vs the classes
 *     around it? "Quite a few products" may already be satisfied by the TRET-C/TRET-H variants.
 *
 *  B. The <=10g population that outranks the Syringes rule — Wart Pen, Lip Gloss Tube, Nail Brush
 *     Bottle, AK Pump. Which of those device classes has REAL purchase evidence in LifeFile
 *     receiving, and which does not? A class with heavy modelled usage and no purchases is a
 *     candidate for being the airless syringe under another name.
 *
 * Run from web/:  npx tsx scripts/_probe-tret-breadth-and-smallfill-purchases.ts
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import {
  classifyDeviceRule,
  deriveForm,
  deriveQty,
  resolveDevice,
} from '../../../../MedRock-Data-Loader/powerbi-sqlite/src/transforms/fifo/devices';

interface FillRow { item: string | null; qty: string | null; location: string | null; fills: number }
interface LotRow {
  product_name: string | null;
  qb_category: string | null;
  yr: string | null;
  qty: number | null;
  cost: number | null;
}

const FILLS_SQL = `
  WITH d2 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Date Filled' AS filled, row_data->>'Dispensed Item Name' AS item
    FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
  ),
  d1 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id, row_data->>'Location' AS location
    FROM source."lifefile_data_1" ORDER BY row_data->>'ID', id ASC
  ),
  d4 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Label Type' AS label, row_data->>'Dispensed Quantity' AS qty
    FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
  )
  SELECT d2.item, d4.qty,
         CASE WHEN position('TN' in upper(coalesce(d1.location,''))) > 0 THEN 'TN'
              WHEN position('FL' in upper(coalesce(d1.location,''))) > 0 THEN 'FL'
              WHEN position('TX' in upper(coalesce(d1.location,''))) > 0 THEN 'TX'
              ELSE '' END AS location,
         count(*)::int AS fills
  FROM d2 JOIN d1 ON d1.id = d2.id JOIN d4 ON d4.id = d2.id
  WHERE trim(coalesce(d4.label,'')) = 'Compound'
    AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') >= '2026-01'
  GROUP BY 1, 2, 3`;

/** Packaging receipts by product name and year — the purchase-evidence side. */
const LOTS_SQL = `
  SELECT p.product_name, p.qb_category,
         to_char(p.date_received, 'YYYY') AS yr,
         sum(p.qty_received)::float8 AS qty,
         sum(p.total_cost)::float8    AS cost
  FROM inventory.purchase_lots p
  WHERE p.qb_category = 'Lab Compound Packaging Inventory'
  GROUP BY 1, 2, 3
  ORDER BY 1, 3`;

async function main(): Promise<void> {
  const pool = getRdsPool();

  // ---- A. breadth per device ------------------------------------------------
  const { rows: fills } = await pool.query<FillRow>(FILLS_SQL);
  const byDevice = new Map<string, { names: Set<string>; fills: number; units: number }>();
  for (const r of fills) {
    if ((r.location ?? '') === '') continue;
    const item = r.item ?? '';
    const qty = deriveQty(r.qty);
    const res = resolveDevice(classifyDeviceRule(item, deriveForm(item), qty), qty);
    if (res.device === 'Unmapped') continue;
    const a = byDevice.get(res.device) ?? { names: new Set<string>(), fills: 0, units: 0 };
    a.names.add(item);
    a.fills += r.fills;
    a.units += res.unitsPerFill * r.fills;
    byDevice.set(res.device, a);
  }
  console.log('===== A. distinct dispensed products per device class (2026) =====');
  console.log('device                    distinct products    fills      units');
  for (const [d, a] of [...byDevice.entries()].sort((x, y) => y[1].units - x[1].units)) {
    console.log(`${d.padEnd(24)} ${String(a.names.size).padStart(14)} ${String(a.fills).padStart(9)} ${a.units.toFixed(0).padStart(10)}`);
  }

  // ---- B. packaging purchase evidence ---------------------------------------
  const { rows: lots } = await pool.query<LotRow>(LOTS_SQL);
  const byProduct = new Map<string, Map<string, { qty: number; cost: number }>>();
  for (const l of lots) {
    const n = (l.product_name ?? '').trim();
    if (n === '') continue;
    const m = byProduct.get(n) ?? new Map<string, { qty: number; cost: number }>();
    m.set(l.yr ?? '?', { qty: l.qty ?? 0, cost: l.cost ?? 0 });
    byProduct.set(n, m);
  }
  console.log('\n===== B. every packaging product ever received, by year (qty) =====');
  const years = ['2022', '2023', '2024', '2025', '2026'];
  console.log(`${'product'.padEnd(46)} ${years.map((y) => y.padStart(9)).join('')}   total $`);
  const sorted = [...byProduct.entries()].sort((a, b) => {
    const t = (m: Map<string, { qty: number; cost: number }>): number =>
      [...m.values()].reduce((s, v) => s + v.cost, 0);
    return t(b[1]) - t(a[1]);
  });
  for (const [name, m] of sorted) {
    const cells = years.map((y) => (m.get(y)?.qty ?? 0).toFixed(0).padStart(9)).join('');
    const total = [...m.values()].reduce((s, v) => s + v.cost, 0);
    console.log(`${name.slice(0, 46).padEnd(46)} ${cells}   $${total.toFixed(0).padStart(9)}`);
  }

  await pool.end();
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
