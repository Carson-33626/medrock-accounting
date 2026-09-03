// READ-ONLY: the 1220.15 Compound Packaging book balance per entity, against what FIFO holds.
import './lib/load-env';
import { qbQueryAll, getConnectedLocations, type Location } from '../src/lib/quickbooks-multi';
import { getRdsPool } from '../src/lib/rds';

interface QbAccount { AcctNum?: string; FullyQualifiedName?: string; CurrentBalance?: number }

async function main(): Promise<void> {
  for (const location of await getConnectedLocations()) {
    const accts = await qbQueryAll<QbAccount>(location as Location, 'Account', '');
    const a = accts.find((x) => x.AcctNum === '1220.15');
    console.log(`${String(location).padEnd(12)} 1220.15 book ${a ? (a.CurrentBalance ?? 0).toFixed(2).padStart(12) : '   (no account)'}  ${a?.FullyQualifiedName ?? ''}`);
  }
  const pool = getRdsPool();
  const { rows } = await pool.query<{ location: string; lots: number; open_lots: number; remaining: string }>(
    `SELECT l.location, count(*)::int AS lots,
            count(*) FILTER (WHERE l.qty_remaining > 0)::int AS open_lots,
            round(sum(l.remaining_value)::numeric, 2)::text AS remaining
     FROM inventory.lot_depletion_ledger l
     JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE p.qb_category = 'Lab Compound Packaging Inventory'
       AND l.as_of_month = (SELECT max(as_of_month) FROM inventory.lot_depletion_ledger)
       AND COALESCE(l.pre_floor_collapsed, false) = false
     GROUP BY l.location ORDER BY l.location`);
  console.log('\nFIFO packaging lots at the latest ledger month:');
  for (const r of rows) console.log(`  ${r.location.padEnd(20)} lots ${String(r.lots).padStart(4)}  open ${String(r.open_lots).padStart(4)}  remaining ${r.remaining.padStart(12)}`);
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
