/**
 * Florida DR-15 sales-tax computation from the RDS feed (source.sales_tax_report).
 *
 * Method (reverse-engineered from the accountant's "Sales Tax Workbook - {month}.xlsx"):
 *   - Filter: Location = 'MedRock Florida' AND Patient State = 'FL' (destination basis;
 *     reproduces her tax-collected figure to the cent — calibrated against Apr 2026).
 *   - Sales basis (B4): summed Subtotal (= her bank-statement deposit, matched to the
 *     penny for Apr 2026 $909,347.57). May be overridden with the actual bank deposit.
 *   - Tax collected (F4): summed Tax.
 *   - Taxable sales (E4): per-transaction tax / (6% + county surtax) from FL DR-15DSS 2026
 *     — correctly handles partially-taxable orders; more accurate than her flat divisor.
 *   - Taxable purchases (E7): manual use-tax input from QB (usually 0); F7 = E7 x 8.5%.
 *   - Box 3 = E4 + E7;  Box 4 = F4 + F7;  Box 1 = basis - Box 4;  Box 2 = Box 1 - Box 3.
 *   - Box B = Box 3 x 1%;  Box 8a = 2.5% of first $1,200 of Box 4, max $30.
 *
 * All arithmetic in integer cents to avoid float drift, rounded once at the edge.
 */

import { getRdsPool } from './rds';
import { flCombinedRate, flCountyKnown, FL_SURTAX_TAX_YEAR } from './fl-surtax';
import type { FlDr15Boxes, FlDr15Response, SalesTaxFiling } from '@/types/sales-tax';

/**
 * This return is the MedRock FLORIDA entity's FL DR-15. Enforced everywhere:
 * source rows are filtered to this location AND ship-to FL, so the FL filing
 * can never include Tennessee- or Texas-origin sales. (The Texas location, and
 * Florida-origin sales shipped into TX, are separate returns — see the filing
 * matrix in docs/superpowers/specs/2026-06-15-sales-tax-filing-automation.md.)
 */
const FL_FILING: SalesTaxFiling = {
  location: 'MedRock Florida',
  filingState: 'FL',
  form: 'DR-15EZ',
};
const FL_LOCATION = FL_FILING.location;
const FLAT_RATE_FOR_COMPARISON = 0.075; // the accountant's Apr-2026 flat divisor

/** One source transaction for the export (no street address — minimize PHI). */
export interface FlSourceRow {
  tx_id: string;
  date: string;
  county: string;
  fips: string;
  state: string;
  zip: string;
  subtotal: number;
  tax: number;
  total_sales: number;
  combined_rate: number;
  taxable_base: number;
}

/** Fetch the FL source transactions for a month, ordered by date, for export. */
export async function fetchFlSourceRows(month: string): Promise<FlSourceRow[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Invalid month: ${month}`);
  const [year, mm] = month.split('-');
  const pool = getRdsPool();
  const res = await pool.query<{
    tx_id: string | null;
    date: string | null;
    county: string | null;
    fips: string | null;
    state: string | null;
    zip: string | null;
    subtotal: string | null;
    tax: string | null;
    total_sales: string | null;
  }>(
    `SELECT row_data->>'Tx ID' AS tx_id, row_data->>'Tx Effective Date' AS date,
            row_data->>'Patient County' AS county, row_data->>'Patient County FIPS' AS fips,
            row_data->>'Patient State' AS state, row_data->>'Patient ZIP' AS zip,
            row_data->>'Subtotal' AS subtotal, row_data->>'Tax' AS tax,
            row_data->>'Total Sales' AS total_sales
     FROM source.sales_tax_report
     WHERE row_data->>'Location' = $1 AND row_data->>'Patient State' = 'FL'
       AND row_data->>'Tx Effective Date' LIKE $2
     ORDER BY row_data->>'Tx Effective Date', row_data->>'Tx ID'`,
    [FL_LOCATION, `${mm}/%/${year}`],
  );
  const num = (s: string | null): number => {
    const v = parseFloat((s ?? '').replace(/[$,\s]/g, ''));
    return Number.isFinite(v) ? v : 0;
  };
  return res.rows.map((r) => {
    const tax = num(r.tax);
    const subtotal = num(r.subtotal);
    const rate = flCombinedRate(r.fips);
    return {
      tx_id: r.tx_id ?? '',
      date: r.date ?? '',
      county: r.county ?? '',
      fips: r.fips ?? '',
      state: r.state ?? '',
      zip: r.zip ?? '',
      subtotal,
      tax,
      total_sales: num(r.total_sales),
      combined_rate: tax > 0 ? rate : 0,
      // base capped at subtotal (see computeFlDr15)
      taxable_base: tax > 0 ? Math.min(subtotal, Math.round((tax / rate) * 100) / 100) : 0,
    };
  });
}

interface FeedRow {
  subtotal: number;
  tax: number;
  total_sales: number;
  fips: string | null;
  state: string | null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Collection allowance: 2.5% of the first $1,200 of tax due, capped at $30 (DR-15). */
function collectionAllowance(taxDue: number): number {
  return round2(Math.min(Math.min(taxDue, 1200) * 0.025, 30));
}

export async function computeFlDr15(
  month: string, // YYYY-MM
  opts: { taxablePurchases?: number; salesBasisOverride?: number } = {},
): Promise<FlDr15Response> {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Invalid month: ${month} (expected YYYY-MM)`);
  }
  const [year, mm] = month.split('-');
  const pool = getRdsPool();

  // MM/DD/YYYY in the feed; match the month with a LIKE on the JSON text.
  const datePattern = `${mm}/%/${year}`;
  const res = await pool.query<{
    subtotal: string;
    tax: string;
    total_sales: string;
    fips: string | null;
    state: string | null;
  }>(
    `SELECT (row_data->>'Subtotal')        AS subtotal,
            (row_data->>'Tax')             AS tax,
            (row_data->>'Total Sales')     AS total_sales,
            (row_data->>'Patient County FIPS') AS fips,
            (row_data->>'Patient State')   AS state
     FROM source.sales_tax_report
     WHERE row_data->>'Location' = $1
       AND row_data->>'Patient State' = 'FL'
       AND row_data->>'Tx Effective Date' LIKE $2`,
    [FL_LOCATION, datePattern],
  );

  const num = (s: string | null): number => {
    const v = parseFloat((s ?? '').replace(/[$,\s]/g, ''));
    return Number.isFinite(v) ? v : 0;
  };
  const rows: FeedRow[] = res.rows.map((r) => ({
    subtotal: num(r.subtotal),
    tax: num(r.tax),
    total_sales: num(r.total_sales),
    fips: r.fips,
    state: r.state,
  }));

  // Cents accumulators
  let subtotalC = 0;
  let totalSalesC = 0;
  let taxC = 0;
  let taxableBaseC = 0; // per-county backout
  let flatBaseC = 0;
  let taxableTxns = 0;
  let unknownCounty = 0;
  const stateAgg = new Map<string, { transactions: number; salesC: number }>();

  for (const r of rows) {
    subtotalC += Math.round(r.subtotal * 100);
    totalSalesC += Math.round(r.total_sales * 100);
    const taxCents = Math.round(r.tax * 100);
    taxC += taxCents;
    if (taxCents > 0) {
      taxableTxns += 1;
      const rate = flCombinedRate(r.fips);
      const subCents = Math.round(r.subtotal * 100);
      // Backed-out taxable base, capped at the actual sale subtotal: when LifeFile
      // collected at a slightly different rate than the county's official 2026 rate,
      // tax/rate can exceed what was sold, which is nonsensical for a taxable base.
      taxableBaseC += Math.min(subCents, Math.round(taxCents / rate));
      flatBaseC += Math.min(subCents, Math.round(taxCents / FLAT_RATE_FOR_COMPARISON));
      if (!flCountyKnown(r.fips)) unknownCounty += 1;
    }
    const st = (r.state || '(blank)').toUpperCase();
    const agg = stateAgg.get(st) ?? { transactions: 0, salesC: 0 };
    agg.transactions += 1;
    agg.salesC += Math.round(r.total_sales * 100);
    stateAgg.set(st, agg);
  }

  // Inputs
  const salesBasisC =
    opts.salesBasisOverride !== undefined ? Math.round(opts.salesBasisOverride * 100) : subtotalC;
  const taxablePurchasesC = Math.round((opts.taxablePurchases ?? 0) * 100);
  const salesUseTaxC = Math.round(taxablePurchasesC * 0.085);

  // Boxes (cents)
  const box3C = taxableBaseC + taxablePurchasesC;
  const box4C = taxC + salesUseTaxC;
  const box1C = salesBasisC - box4C;
  const box2C = box1C - box3C;
  const boxBC = Math.round(box3C * 0.01);

  const boxes: FlDr15Boxes = {
    month,
    box1_gross: round2(box1C / 100),
    box2_exempt: round2(box2C / 100),
    box3_taxable: round2(box3C / 100),
    box4_tax: round2(box4C / 100),
    boxB_surtax: round2(boxBC / 100),
    box8a_allowance: collectionAllowance(box4C / 100),
  };

  // Feed freshness
  const freshRes = await pool.query<{ as_of: string | null }>(
    `SELECT max(ingested_at)::text AS as_of FROM source.sales_tax_report`,
  );

  const shipToStates = [...stateAgg.entries()]
    .map(([state, v]) => ({ state, transactions: v.transactions, sales: round2(v.salesC / 100) }))
    .sort((a, b) => b.sales - a.sales);

  return {
    month,
    filing: FL_FILING,
    boxes,
    inputs: {
      salesBasis: round2(salesBasisC / 100),
      salesBasisSource: opts.salesBasisOverride !== undefined ? 'bank_statement' : 'sales_sum',
      taxableSales: round2(taxableBaseC / 100),
      taxCollected: round2(taxC / 100),
      taxablePurchases: round2(taxablePurchasesC / 100),
      salesUseTax: round2(salesUseTaxC / 100),
    },
    diagnostics: {
      totalTransactions: rows.length,
      taxableTransactions: taxableTxns,
      summedSubtotal: round2(subtotalC / 100),
      summedTotalSales: round2(totalSalesC / 100),
      unknownCountyRows: unknownCounty,
      flatRateTaxableBase: round2(flatBaseC / 100),
      flatRate: FLAT_RATE_FOR_COMPARISON,
      shipToStates,
      surtaxTaxYear: FL_SURTAX_TAX_YEAR,
      surtaxStale: Number(year) > FL_SURTAX_TAX_YEAR,
    },
    feedAsOf: freshRes.rows[0]?.as_of ?? null,
  };
}
