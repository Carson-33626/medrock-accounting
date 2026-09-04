/**
 * READ-ONLY: is packaging receiving genuinely absent in 2026, or is that an artifact of the
 * qb_category filter? Compares last-receipt dates and monthly lot counts per category.
 *
 * Run from web/:  npx tsx scripts/_probe-packaging-receiving-stopped.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface CatRow { qb_category: string | null; lots: string; last_rx: string | null; qty2026: number | null }
interface MonRow { month: string | null; qb_category: string | null; lots: string }

async function main(): Promise<void> {
  const pool = getRdsPool();

  const { rows: cats } = await pool.query<CatRow>(`
    SELECT coalesce(qb_category, '(null)') AS qb_category,
           count(*)::text AS lots,
           to_char(max(date_received), 'YYYY-MM-DD') AS last_rx,
           sum(CASE WHEN date_received >= DATE '2026-01-01' THEN qty_received ELSE 0 END)::float8 AS qty2026
    FROM inventory.purchase_lots
    GROUP BY 1 ORDER BY 2 DESC`);
  console.log('===== purchase_lots by category =====');
  console.log(`${'category'.padEnd(38)} ${'lots'.padStart(8)}  last receipt   2026 qty`);
  for (const c of cats) {
    console.log(`${(c.qb_category ?? '').padEnd(38)} ${c.lots.padStart(8)}  ${(c.last_rx ?? '—').padEnd(12)} ${(c.qty2026 ?? 0).toFixed(0).padStart(11)}`);
  }

  const { rows: mons } = await pool.query<MonRow>(`
    SELECT to_char(date_received, 'YYYY-MM') AS month,
           coalesce(qb_category, '(null)') AS qb_category,
           count(*)::text AS lots
    FROM inventory.purchase_lots
    WHERE date_received >= DATE '2025-06-01'
      AND qb_category IN ('Lab Compound Packaging Inventory', 'Compound Ingredient', 'Commercial Rx')
    GROUP BY 1, 2 ORDER BY 1, 2`);
  console.log('\n===== lots per month since 2025-06, three categories =====');
  for (const m of mons) {
    console.log(`${m.month}  ${(m.qb_category ?? '').padEnd(34)} ${m.lots.padStart(6)}`);
  }

  await pool.end();
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
