/** READ-ONLY: which month-end count snapshots exist around 2025-12, per location. */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
interface C { column_name: string }
interface R { m: string; location: string; n: number }
async function main(): Promise<void> {
  const pool = getRdsPool();
  for (const t of ['inventory.balance_on_hand_commercial', 'inventory.balance_on_hand_compound']) {
    const [schema, table] = t.split('.');
    const cols = await pool.query<C>(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, table]);
    const names = cols.rows.map((c) => c.column_name);
    console.log(`\n${t}: ${names.join(', ')}`);
    const mcol = names.find((n) => /snapshot_month|as_of_month|month/.test(n)) ?? names.find((n) => /date|as_of/.test(n));
    const lcol = names.find((n) => /location|pharmacy/.test(n));
    if (!mcol || !lcol) continue;
    const r = await pool.query<R>(`SELECT left(${mcol}::text,7) AS m, ${lcol} AS location, count(*)::int AS n FROM ${t} WHERE left(${mcol}::text,7) BETWEEN '2025-09' AND '2026-03' GROUP BY 1,2 ORDER BY 1,2`);
    for (const x of r.rows) console.log(`  ${x.m} ${String(x.location).padEnd(20)} ${x.n} rows`);
  }
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
