/** READ-ONLY: ledger totals 2025-11..2026-03 by location, anchored rows, and 2026-01 COGS. */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
interface R { as_of_month: string; location: string; ending: number; anchored: number; lots: number; consumed: number }
async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<R>(
    `SELECT l.as_of_month, l.location,
            sum(l.remaining_value)::float8 AS ending,
            count(*) FILTER (WHERE l.lot_anchored)::int AS anchored,
            count(*)::int AS lots,
            sum(l.qty_consumed * COALESCE(p.unit_cost,0))::float8 AS consumed
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month BETWEEN '2025-11' AND '2026-03' AND COALESCE(l.pre_floor_collapsed,false)=false
     GROUP BY 1,2 ORDER BY 1,2`);
  for (const r of rows) console.log(`${r.as_of_month} ${r.location.padEnd(20)} ending ${r.ending.toFixed(2).padStart(14)}  consumed ${r.consumed.toFixed(2).padStart(14)}  anchored ${String(r.anchored).padStart(6)}/${r.lots}`);
  const t = await pool.query<{ table_name: string }>(
    `SELECT table_schema||'.'||table_name AS table_name FROM information_schema.tables WHERE table_name ILIKE '%balance%' OR table_name ILIKE '%on_hand%' OR table_name ILIKE '%snapshot%' ORDER BY 1`);
  console.log('\ncandidate count tables:'); for (const r of t.rows) console.log('  ' + r.table_name);
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
