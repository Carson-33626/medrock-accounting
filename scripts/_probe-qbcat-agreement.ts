/**
 * READ-ONLY: does the ledger's new `qb_category` agree with `purchase_lots.qb_category`?
 *
 * Decides which side of the COALESCE wins in `ledger-values.ts`. If they agree
 * everywhere a purchase lot exists, the ledger stamp can simply be preferred and
 * the invented 'Opening Balance' bucket drops out. If they disagree, preferring
 * one silently moves value between categories, so measure before choosing.
 *
 * Run from web/:  npx tsx scripts/_probe-qbcat-agreement.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface Row { p_cat: string | null; l_cat: string | null; rows: number; ending: number }

async function main(): Promise<void> {
  const pool = getRdsPool();

  const { rows } = await pool.query<Row>(
    `SELECT p.qb_category AS p_cat, l.qb_category AS l_cat,
            count(*)::int AS rows,
            round(sum(COALESCE(l.remaining_value,0))::numeric, 2)::float8 AS ending
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month = '2026-03'
       AND COALESCE(p.qb_category,'~') IS DISTINCT FROM COALESCE(l.qb_category,'~')
     GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`,
  );

  if (rows.length === 0) {
    console.log('2026-03: ledger qb_category and purchase_lots qb_category agree on EVERY row.');
  } else {
    console.log('2026-03 DISAGREEMENTS (purchase_lots -> ledger):');
    for (const r of rows) {
      console.log(
        `  ${(r.p_cat ?? '(null)').padEnd(30)} -> ${(r.l_cat ?? '(null)').padEnd(30)}` +
          ` ${String(r.rows).padStart(7)} rows  $${r.ending.toLocaleString()}`,
      );
    }
  }

  const nulls = await pool.query<{ rows: number; ending: number }>(
    `SELECT count(*)::int AS rows, round(sum(COALESCE(l.remaining_value,0))::numeric,2)::float8 AS ending
     FROM inventory.lot_depletion_ledger l
     WHERE l.as_of_month = '2026-03' AND l.qb_category IS NULL`,
  );
  console.log(
    `\n2026-03 ledger rows with NULL qb_category: ${nulls.rows[0]?.rows} ($${(nulls.rows[0]?.ending ?? 0).toLocaleString()})`,
  );

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
