/**
 * READ-ONLY: what purchasing actually RECEIVED for the three device rows.
 *
 * Lot-level (LifeFile receiving mirrored into inventory.purchase_lots) gives a stated
 * quantity next to a stated cost, which is the only place a real $/unit and a real case
 * size can be read rather than assumed.
 *
 * Run from web/:  npx tsx scripts/_probe-three-device-lots.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface LotRow {
  location: string | null;
  product_name: string | null;
  qb_category: string | null;
  receipt_date: string | null;
  package_size: number | null;
  price_per_package: number | null;
  vendor: string | null;
  qty_received: number | null;
  total_cost: number | null;
}

const SQL = `
  SELECT p.location,
         p.product_name,
         p.qb_category,
         to_char(p.date_received, 'YYYY-MM-DD') AS receipt_date,
         p.package_size::float8 AS package_size,
         p.price_per_package::float8 AS price_per_package,
         p.vendor,
         p.qty_received::float8 AS qty_received,
         p.total_cost::float8   AS total_cost
  FROM inventory.purchase_lots p
  WHERE upper(coalesce(p.product_name, '')) ~ $1
  ORDER BY p.product_name, p.date_received`;

const PATTERN = 'SYRINGE|TRET|EYE|PAD|PATCH|MASK|SCAR';

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<LotRow>(SQL, [PATTERN]);

  interface Agg { qty: number; cost: number; lots: number; first: string; last: string; cats: Set<string>; locs: Set<string> }
  const byName = new Map<string, Agg>();
  const byName2026 = new Map<string, Agg>();

  const add = (m: Map<string, Agg>, name: string, r: LotRow): void => {
    const a = m.get(name) ?? { qty: 0, cost: 0, lots: 0, first: '9999', last: '0000', cats: new Set<string>(), locs: new Set<string>() };
    a.qty += r.qty_received ?? 0;
    a.cost += r.total_cost ?? 0;
    a.lots += 1;
    const d = r.receipt_date ?? '';
    if (d !== '' && d < a.first) a.first = d;
    if (d !== '' && d > a.last) a.last = d;
    if (r.qb_category) a.cats.add(r.qb_category);
    if (r.location) a.locs.add(r.location.replace('MedRock ', ''));
    m.set(name, a);
  };

  for (const r of rows) {
    const name = (r.product_name ?? '').trim();
    if (name === '') continue;
    add(byName, name, r);
    if ((r.receipt_date ?? '') >= '2026-01-01') add(byName2026, name, r);
  }

  const dump = (title: string, m: Map<string, Agg>): void => {
    console.log(`\n===== ${title} (${m.size} product names) =====`);
    const sorted = [...m.entries()].sort((a, b) => b[1].cost - a[1].cost);
    for (const [name, a] of sorted) {
      const unit = a.qty > 0 ? (a.cost / a.qty).toFixed(4) : '—';
      console.log(
        `${name.slice(0, 62).padEnd(62)} qty ${a.qty.toFixed(0).padStart(8)}  $${a.cost.toFixed(2).padStart(11)}  $/u ${unit.padStart(9)}  ` +
        `lots ${String(a.lots).padStart(3)}  ${a.first}..${a.last}  ${[...a.locs].sort().join('/')}  ${[...a.cats].join('|').slice(0, 34)}`,
      );
    }
  };

  dump('ALL TIME', byName);
  dump('2026 RECEIPTS ONLY', byName2026);

  // Every individual 2026 lot for the airless syringe + tret pump — the case-size question.
  console.log('\n===== individual 2026 lots: SYRINGE AIRLESS / TRET PUMP =====');
  for (const r of rows) {
    const n = (r.product_name ?? '').toUpperCase();
    if (!(n.includes('SYRINGE') || n.includes('TRET PUMP') || n.includes('HYDROGEL'))) continue;
    const q = r.qty_received ?? 0;
    const c = r.total_cost ?? 0;
    console.log(
      `${r.receipt_date}  ${(r.location ?? '').replace('MedRock ', '').padEnd(4)} qty ${q.toFixed(0).padStart(7)}  pkgsz ${String(r.package_size ?? '').padStart(7)}  $/pkg ${String(r.price_per_package ?? '').padStart(9)}  $${c.toFixed(2).padStart(10)}  $/u ${(q > 0 ? c / q : 0).toFixed(4).padStart(9)}  ${(r.vendor ?? '').slice(0, 16).padEnd(16)} ${(r.product_name ?? '').slice(0, 55)}`,
    );
  }

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
