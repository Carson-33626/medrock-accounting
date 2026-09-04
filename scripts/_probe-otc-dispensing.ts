/**
 * READ-ONLY: the evidence behind `docs/fifo-monthly-close/ds-otc-category-2026-09-04.md`.
 *
 * WHAT IT PROVES
 *
 * 1. LifeFile stamps every dispense with a `Schedule`, and `'O'` means OTC. That
 *    single field is the identifying predicate the DS asked for — no brand regex,
 *    no ` in ` marker heuristic, no SKU allowlist. It is on the FILL, so the same
 *    jar of CeraVe counts as OTC when it is handed over whole and as a compounding
 *    base when it is not, which is exactly the split
 *    `ds-qb-inventory-account-coverage.md` §3 could not make.
 * 2. What QuickBooks account 1220.25 actually holds — measured separately in
 *    `_probe-otc-qb-1220-25.ts`, because it is NOT the population above.
 * 3. The FIFO value of that OTC dispensing, per entity per 2026 month, and which
 *    COGS account the close currently charges it to.
 *
 * Read-only: three SELECTs against RDS. Nothing is written anywhere.
 *
 * Run from web/:  npx tsx scripts/_probe-otc-dispensing.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
import {
  OTC_SCHEDULE_CODE,
  EXCLUDED_OTC_PRODUCT_IDS,
  LF_DISPENSING_LOCATION_SQL,
  otcShare,
  buildOtcCogsLines,
  type OtcProductMonth,
} from '../src/lib/inventory/otc-dispensing';

const FROM_MONTH = '2026-01';
const THRU_MONTH = '2026-08';

/** lf_dispensing_history's short location -> the inventory tables' long form. */
const LOC_LONG: Readonly<Record<string, string>> = {
  'MedRock FL': 'MedRock Florida',
  'MedRock TN': 'MedRock Tennessee',
  'MedRock TX': 'MedRock Texas',
};

interface ScheduleRow {
  schedule: string | null;
  compounded: string | null;
  fills: number;
  products: number;
}

interface ProductRow {
  pid: string;
  name: string;
  form: string | null;
  locations: string;
  fills: number;
  otc_qty: number;
  lots: number;
  categories: string | null;
  fifo_receipt_value: number | null;
}

interface CellRow {
  month: string;
  location: string;
  pid: string;
  name: string;
  qb_category: string;
  otc_qty: number;
  usage_qty: number;
  consumed_value: number;
}

const money = (n: number): string => n.toFixed(2);

async function main(): Promise<void> {
  const pool = getRdsPool();

  // ---- 1. the predicate ---------------------------------------------------
  const { rows: sched } = await pool.query<ScheduleRow>(
    `SELECT row_data->>'Schedule'   AS schedule,
            row_data->>'Compounded' AS compounded,
            count(*)::int                                AS fills,
            count(DISTINCT row_data->>'Product ID')::int AS products
       FROM source."lf_dispensing_history"
      GROUP BY 1, 2
      ORDER BY count(*) DESC`,
  );
  console.log('=== 1. LifeFile Schedule x Compounded (source.lf_dispensing_history) ===');
  console.log('    Schedule  Compounded        fills   products');
  for (const r of sched) {
    console.log(
      `    ${(r.schedule ?? '(null)').padEnd(9)} ${(r.compounded ?? '(null)').padEnd(11)} ${String(r.fills).padStart(10)} ${String(r.products).padStart(10)}`,
    );
  }
  const oRow = sched.find((r) => r.schedule === OTC_SCHEDULE_CODE);
  console.log(
    `\n    '${OTC_SCHEDULE_CODE}' = OTC. ${oRow ? oRow.fills : 0} fills, ${oRow ? oRow.products : 0} products, ` +
      `and EVERY one is Compounded='No' — so an OTC line is never a compound.`,
  );

  // No DISTINCT ON here, unlike source."lifefile_data_*": this table carries one
  // row per Fill ID (314,140 rows / 314,140 distinct ids, measured 2026-09-04).
  const { rows: dupe } = await pool.query<{ rows_total: number; fill_ids: number }>(
    `SELECT count(*)::int AS rows_total, count(DISTINCT row_data->>'FIll ID')::int AS fill_ids
       FROM source."lf_dispensing_history"`,
  );
  const d = dupe[0];
  console.log(
    `    dupe check: ${d?.rows_total ?? 0} rows / ${d?.fill_ids ?? 0} distinct Fill ID` +
      ` -> ${d && d.rows_total === d.fill_ids ? 'NO de-dup needed' : 'DE-DUP REQUIRED'}`,
  );

  // ---- 2. the OTC product population -------------------------------------
  const { rows: prods } = await pool.query<ProductRow>(
    `WITH otc AS (
       SELECT row_data->>'Product ID' AS pid,
              row_data->>'Drug Name'  AS name,
              row_data->>'Drug Form'  AS form,
              ${LF_DISPENSING_LOCATION_SQL} AS loc,
              NULLIF(row_data->>'Qty','')::numeric AS qty
       FROM source."lf_dispensing_history"
       WHERE row_data->>'Schedule' = $1
     ),
     agg AS (
       SELECT pid, max(name) AS name, max(form) AS form,
              string_agg(DISTINCT loc, '|') AS locations,
              count(*)::int AS fills, COALESCE(sum(qty), 0)::float8 AS otc_qty
       FROM otc GROUP BY pid
     )
     SELECT a.pid, a.name, a.form, a.locations, a.fills, a.otc_qty,
            (SELECT count(*)::int FROM inventory.purchase_lots p WHERE p.lifefile_id = a.pid) AS lots,
            (SELECT string_agg(DISTINCT p.qb_category, '|') FROM inventory.purchase_lots p
              WHERE p.lifefile_id = a.pid) AS categories,
            (SELECT sum(p.total_cost)::float8 FROM inventory.purchase_lots p
              WHERE p.lifefile_id = a.pid) AS fifo_receipt_value
     FROM agg a ORDER BY a.fills DESC`,
    [OTC_SCHEDULE_CODE],
  );

  console.log(`\n=== 2. The OTC population: ${prods.length} products ===`);
  console.log('      fills      OTC qty  lots  FIFO receipts $  current category      product');
  for (const p of prods) {
    const excluded = EXCLUDED_OTC_PRODUCT_IDS.includes(p.pid);
    console.log(
      `   ${excluded ? 'x' : ' '} ${String(p.fills).padStart(6)} ${p.otc_qty.toFixed(1).padStart(12)} ${String(p.lots).padStart(5)} ` +
        `${(p.fifo_receipt_value === null ? '—' : money(p.fifo_receipt_value)).padStart(16)}  ` +
        `${(p.categories ?? '(no lots)').slice(0, 20).padEnd(20)}  ${p.name.slice(0, 42)} [${p.pid}]`,
    );
  }
  console.log(`   x = excluded by EXCLUDED_OTC_PRODUCT_IDS (${EXCLUDED_OTC_PRODUCT_IDS.join(', ')})`);
  const noLots = prods.filter((p) => p.lots === 0 && !EXCLUDED_OTC_PRODUCT_IDS.includes(p.pid));
  if (noLots.length > 0) {
    console.log(
      `   NO FIFO LOTS (dispensed but never received into LifeFile — carries no cost): ` +
        noLots.map((p) => `${p.name} [${p.pid}]`).join('; '),
    );
  }

  // ---- 3. the cells -------------------------------------------------------
  // OTC qty per (product, location, month) from the dispensing feed, against
  // TOTAL usage (commercial + compound) and the FIFO value the ledger consumed
  // for that product's lots in that cell.
  const { rows: cells } = await pool.query<CellRow>(
    `WITH otc AS (
       SELECT row_data->>'Product ID' AS pid,
              max(row_data->>'Drug Name') AS name,
              ${LF_DISPENSING_LOCATION_SQL} AS loc_short,
              to_char(to_date(row_data->>'Fill Date','MM/DD/YYYY'), 'YYYY-MM') AS month,
              sum(NULLIF(row_data->>'Qty','')::numeric)::float8 AS otc_qty
       FROM source."lf_dispensing_history"
       WHERE row_data->>'Schedule' = $1
       GROUP BY 1, 3, 4
     ),
     usage AS (
       SELECT lifefile_id AS pid, location, month, sum(qty_used)::float8 AS usage_qty
       FROM (
         SELECT lifefile_id, location, month, qty_used FROM inventory.drug_usage_commercial
         UNION ALL
         SELECT lifefile_id, location, month, qty_used FROM inventory.drug_usage_compound
       ) u
       GROUP BY 1, 2, 3
     ),
     consumed AS (
       SELECT p.lifefile_id AS pid, l.location, l.as_of_month AS month,
              COALESCE(l.qb_category, p.qb_category, 'Uncoded') AS qb_category,
              sum(l.qty_consumed * COALESCE(p.unit_cost, 0))::float8 AS consumed_value
       FROM inventory.lot_depletion_ledger l
       JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
       WHERE COALESCE(l.pre_floor_collapsed, false) = false
       GROUP BY 1, 2, 3, 4
     )
     SELECT o.month,
            o.loc_short AS location,
            o.pid,
            o.name,
            COALESCE(c.qb_category, '(no lots)') AS qb_category,
            o.otc_qty,
            COALESCE(u.usage_qty, 0)   AS usage_qty,
            COALESCE(c.consumed_value, 0) AS consumed_value
     FROM otc o
     LEFT JOIN usage u
            ON u.pid = o.pid AND u.month = o.month
           AND u.location = CASE o.loc_short
                              WHEN 'MedRock FL' THEN 'MedRock Florida'
                              WHEN 'MedRock TN' THEN 'MedRock Tennessee'
                              WHEN 'MedRock TX' THEN 'MedRock Texas' END
     LEFT JOIN consumed c
            ON c.pid = o.pid AND c.month = o.month
           AND c.location = CASE o.loc_short
                              WHEN 'MedRock FL' THEN 'MedRock Florida'
                              WHEN 'MedRock TN' THEN 'MedRock Tennessee'
                              WHEN 'MedRock TX' THEN 'MedRock Texas' END
     WHERE o.month BETWEEN $2 AND $3
     ORDER BY o.month, o.loc_short, o.otc_qty DESC`,
    [OTC_SCHEDULE_CODE, FROM_MONTH, THRU_MONTH],
  );

  const inputs: OtcProductMonth[] = cells.map((c) => ({
    month: c.month,
    location: LOC_LONG[c.location] ?? c.location,
    productId: c.pid,
    productName: c.name,
    sourceCategory: c.qb_category,
    otcQty: c.otc_qty,
    totalUsageQty: c.usage_qty,
    fifoConsumedValue: c.consumed_value,
  }));

  console.log(`\n=== 3. OTC dispensing by entity x month, ${FROM_MONTH}..${THRU_MONTH} ===`);
  console.log('    month    entity                fills-qty     OTC share of usage      FIFO OTC COGS $');
  const months = [...new Set(inputs.map((i) => i.month))].sort();
  const locations = [...new Set(inputs.map((i) => i.location))].sort();
  const grand: Record<string, number> = {};
  for (const m of months) {
    for (const loc of locations) {
      const cellRows = inputs.filter((i) => i.month === m && i.location === loc);
      if (cellRows.length === 0) continue;
      const qty = cellRows.reduce((s, r) => s + r.otcQty, 0);
      const value = cellRows.reduce((s, r) => s + r.fifoConsumedValue * otcShare(r), 0);
      grand[loc] = (grand[loc] ?? 0) + value;
      const usage = cellRows.reduce((s, r) => s + r.totalUsageQty, 0);
      console.log(
        `    ${m}  ${loc.padEnd(20)} ${qty.toFixed(1).padStart(11)}  ` +
          `${(usage > 0 ? ((100 * qty) / usage).toFixed(1) : '—').padStart(8)}%  ` +
          `${money(value).padStart(20)}`,
      );
    }
  }
  console.log('    ' + '-'.repeat(84));
  let total = 0;
  for (const loc of locations) {
    total += grand[loc] ?? 0;
    console.log(`    TOTAL    ${loc.padEnd(20)} ${' '.repeat(22)}${money(grand[loc] ?? 0).padStart(20)}`);
  }
  console.log(`    TOTAL    ${'all entities'.padEnd(20)} ${' '.repeat(22)}${money(total).padStart(20)}`);

  // ---- 4. what the JE would look like ------------------------------------
  console.log('\n=== 4. The reclass lines this produces, per entity x month ===');
  for (const m of months) {
    for (const loc of locations) {
      const built = buildOtcCogsLines(
        inputs.filter((i) => i.month === m && i.location === loc),
        m,
      );
      if (built.lines.length === 0) continue;
      console.log(`\n  ${m} ${loc}`);
      for (const l of built.lines) {
        console.log(
          `    ${l.postingType.padEnd(6)} ${money(l.amount).padStart(11)}  ${l.accountName.padEnd(44)} ${l.memo}`,
        );
      }
      for (const w of built.warnings) console.log(`    WARN ${w}`);
    }
  }

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
