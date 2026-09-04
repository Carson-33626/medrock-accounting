// READ-ONLY: who do we buy packaging/devices from? Lot-side vendors + QB 1220.15 vendors, 2026.
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
import { qbQueryAll, getConnectedLocations, type Location } from '../src/lib/quickbooks-multi';

interface Acct { Id: string; AcctNum?: string }
interface Line { Amount?: number; AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string } } }
interface Doc { Id: string; TxnDate?: string; DocNumber?: string; VendorRef?: { name?: string }; Line?: Line[] }

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<{ vendor: string | null; lots: number; units: number; cost: number }>(
    `SELECT p.vendor, count(*)::int AS lots,
            sum(p.qty_received)::float8 AS units, sum(p.total_cost)::float8 AS cost
     FROM inventory.purchase_lots p
     WHERE p.qb_category = 'Lab Compound Packaging Inventory'
     GROUP BY 1 ORDER BY 4 DESC NULLS LAST`);
  console.log('LOT-SIDE vendors on packaging receipts (all time):');
  for (const r of rows) {
    console.log(`  ${(r.vendor ?? '(none)').padEnd(34)} ${String(r.lots).padStart(4)} lots  ${Math.round(r.units).toString().padStart(8)} units  $${(r.cost ?? 0).toFixed(2).padStart(11)}`);
  }
  await pool.end();

  for (const location of await getConnectedLocations()) {
    if (String(location) === 'FOCAS') continue;
    try {
      const accts = await qbQueryAll<Acct>(location as Location, 'Account', '');
      const ids = new Set(accts.filter((a) => a.AcctNum === '1220.15').map((a) => a.Id));
      if (ids.size === 0) continue;
      const where = `WHERE TxnDate >= '2026-01-01'`;
      const [bills, purchases] = await Promise.all([
        qbQueryAll<Doc>(location as Location, 'Bill', where),
        qbQueryAll<Doc>(location as Location, 'Purchase', where),
      ]);
      const byVendor = new Map<string, { amt: number; docs: number }>();
      for (const d of [...bills, ...purchases]) {
        let hit = 0;
        for (const l of d.Line ?? []) {
          const ref = l.AccountBasedExpenseLineDetail?.AccountRef?.value;
          if (ref && ids.has(ref)) hit += l.Amount ?? 0;
        }
        if (hit === 0) continue;
        const v = d.VendorRef?.name ?? '(no vendor)';
        const acc = byVendor.get(v) ?? { amt: 0, docs: 0 };
        acc.amt += hit; acc.docs += 1;
        byVendor.set(v, acc);
      }
      console.log(`\nQB 1220.15 vendors — ${location}, 2026 YTD:`);
      for (const [v, a] of [...byVendor.entries()].sort((x, y) => y[1].amt - x[1].amt)) {
        console.log(`  ${v.padEnd(34)} $${a.amt.toFixed(2).padStart(11)}  ${a.docs} docs`);
      }
    } catch (e) {
      console.log(`${location}: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
