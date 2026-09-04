/**
 * READ-ONLY: every packaging purchase lot behind the device-pricing worksheet's
 * "Observed $/unit" column, receipt by receipt.
 *
 * `probe-device-pricing-sheet.ts` blends these into one number per product. That hides the
 * thing we need to see: whether a given anchor rests on a sane per-unit receipt or on a
 * CASE-priced one (a case booked as a unit). `ds-device-depletion-integration.md` §7 already
 * flags Tret Pump 20g @ $189.64 and an FL syringe receipt at $441/unit on exactly that
 * suspicion, so print the lots and let the outliers show themselves.
 *
 * Run from web/:  npx tsx scripts/_probe-device-lot-prices.ts
 * SELECTs only. Writes nothing, anywhere.
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface LotRow {
  location: string;
  product_name: string | null;
  vendor: string | null;
  received_at: string | null;
  qty_received: number;
  total_cost: number;
  unit_cost: number;
  receipt_id: string;
}

const LOTS_SQL = `
  SELECT l.location,
         p.product_name,
         p.vendor,
         to_char(p.date_received, 'YYYY-MM-DD') AS received_at,
         p.qty_received::float8 AS qty_received,
         p.total_cost::float8 AS total_cost,
         (p.total_cost / NULLIF(p.qty_received, 0))::float8 AS unit_cost,
         p.receipt_id::text AS receipt_id
  FROM inventory.lot_depletion_ledger l
  JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
  WHERE p.qb_category = 'Lab Compound Packaging Inventory'
    AND l.as_of_month = (SELECT max(as_of_month) FROM inventory.lot_depletion_ledger)
    AND COALESCE(l.pre_floor_collapsed, false) = false
    AND p.qty_received > 0
  ORDER BY upper(p.product_name), p.date_received`;

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<LotRow>(LOTS_SQL);
  console.log('location,product_name,vendor,received_at,qty_received,total_cost,unit_cost,receipt_id');
  for (const r of rows) {
    const cells: readonly string[] = [
      r.location,
      r.product_name ?? '',
      r.vendor ?? '',
      r.received_at ?? '',
      String(r.qty_received),
      r.total_cost.toFixed(2),
      r.unit_cost.toFixed(4),
      r.receipt_id,
    ];
    console.log(cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','));
  }
  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
