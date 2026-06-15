/**
 * Tennessee Sales & Use Tax (SLS-450) computation from the RDS feed.
 *
 * MedRock Tennessee files ONE annual SLS-450 (period ending 12/31, due Jan 20), via TNTAP.
 * Method (from Carson's Pestle SOP — the same backout as FL/TX):
 *   - Gross Sales (Line 1) = Σ Subtotal for the year.
 *   - Taxable Sales = Σ Tax ÷ 9.25% (combined Hamilton-Co. rate: 7% state + 2.25% local).
 *   - Exempt / deductions = Gross Sales − Taxable Sales.
 *   - State tax = taxable × 7%; Local tax = taxable × 2.25%. Total ties to tax collected.
 *
 * Scope: Location = 'MedRock Tennessee' AND Patient State = 'TN', for the calendar year.
 * The feed starts 2026-01, so years before 2026 are not reproducible here (CY2025 and earlier
 * were filed from LifeFile directly). See docs/superpowers/specs/2026-06-15-tennessee-sales-tax.md.
 */

import { getRdsPool } from './rds';
import type { SalesTaxFiling, TnReturnResponse } from '@/types/sales-tax';

const STATE_RATE = 0.07;
const LOCAL_RATE = 0.0225; // Hamilton County (Chattanooga) local option
const COMBINED_RATE = STATE_RATE + LOCAL_RATE; // 0.0925
/** Earliest month the LifeFile feed carries. */
export const TN_FEED_START = '2026-01';

export const TN_FILING: SalesTaxFiling = {
  location: 'MedRock Tennessee',
  filingState: 'TN',
  form: 'SLS-450',
};

const YEAR_RE = /^\d{4}$/;

/** One source transaction for the export (no street address — minimize PHI). */
export interface TnSourceRow {
  tx_id: string;
  date: string;
  city: string;
  county: string;
  zip: string;
  subtotal: number;
  tax: number;
  total_sales: number;
  taxable_base: number;
}

const num = (s: string | null): number => {
  const v = parseFloat((s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(v) ? v : 0;
};

interface FeedRow {
  tx_id: string;
  date: string;
  month: string;
  city: string;
  county: string;
  zip: string;
  subtotal: number;
  tax: number;
  total_sales: number;
}

async function fetchRows(year: string): Promise<FeedRow[]> {
  const pool = getRdsPool();
  const res = await pool.query<{
    tx_id: string | null;
    date: string | null;
    city: string | null;
    county: string | null;
    zip: string | null;
    subtotal: string | null;
    tax: string | null;
    total_sales: string | null;
  }>(
    `SELECT row_data->>'Tx ID' AS tx_id, row_data->>'Tx Effective Date' AS date,
            row_data->>'Patient City' AS city, row_data->>'Patient County' AS county,
            row_data->>'Patient ZIP' AS zip, row_data->>'Subtotal' AS subtotal,
            row_data->>'Tax' AS tax, row_data->>'Total Sales' AS total_sales
     FROM source.sales_tax_report
     WHERE row_data->>'Location' = 'MedRock Tennessee'
       AND row_data->>'Patient State' = 'TN'
       AND row_data->>'Tx Effective Date' LIKE $1
     ORDER BY row_data->>'Tx Effective Date', row_data->>'Tx ID'`,
    [`%/${year}`],
  );
  return res.rows.map((r) => ({
    tx_id: r.tx_id ?? '',
    date: r.date ?? '',
    month: (r.date ?? '').split('/')[0] ?? '',
    city: r.city ?? '',
    county: r.county ?? '',
    zip: r.zip ?? '',
    subtotal: num(r.subtotal),
    tax: num(r.tax),
    total_sales: num(r.total_sales),
  }));
}

/** Fetch the TN source transactions for a year, for export. */
export async function fetchTnSourceRows(year: string): Promise<TnSourceRow[]> {
  if (!YEAR_RE.test(year)) throw new Error(`Invalid year: ${year}`);
  const rows = await fetchRows(year);
  return rows.map((r) => {
    const taxCents = Math.round(r.tax * 100);
    const subCents = Math.round(r.subtotal * 100);
    return {
      tx_id: r.tx_id,
      date: r.date,
      city: r.city,
      county: r.county,
      zip: r.zip,
      subtotal: r.subtotal,
      tax: r.tax,
      total_sales: r.total_sales,
      taxable_base: taxCents > 0 ? Math.min(subCents, Math.round(taxCents / COMBINED_RATE)) / 100 : 0,
    };
  });
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export async function computeTnReturn(
  year: string,
  opts: { taxablePurchases?: number } = {},
): Promise<TnReturnResponse> {
  if (!YEAR_RE.test(year)) throw new Error(`Invalid year: ${year} (expected YYYY)`);
  const rows = await fetchRows(year);

  let subtotalCents = 0;
  let taxCents = 0;
  let taxableTxns = 0;
  const monthsSeen = new Set<string>();
  for (const r of rows) {
    subtotalCents += Math.round(r.subtotal * 100);
    const tc = Math.round(r.tax * 100);
    taxCents += tc;
    if (tc > 0) taxableTxns += 1;
    if (r.month) monthsSeen.add(r.month);
  }

  // SOP: taxable = Σ tax ÷ combined rate (aggregate backout — ties total tax to collected).
  const grossSales = round2(subtotalCents / 100);
  const taxableSales = round2(taxCents / 100 / COMBINED_RATE);
  const taxablePurchases = Math.max(0, round2(opts.taxablePurchases ?? 0));
  const exemptSales = round2(grossSales - taxableSales);
  const stateBase = taxableSales + taxablePurchases;
  const stateTaxDue = round2(stateBase * STATE_RATE);
  const localTaxDue = round2(stateBase * LOCAL_RATE);
  const totalTaxDue = round2(stateTaxDue + localTaxDue);

  const freshRes = await getRdsPool().query<{ as_of: string | null }>(
    `SELECT max(ingested_at)::text AS as_of FROM source.sales_tax_report`,
  );

  const monthsCovered = [...monthsSeen].sort();

  return {
    period: year,
    filing: TN_FILING,
    boxes: {
      period: year,
      grossSales,
      taxableSales,
      taxablePurchases,
      exemptSales,
      stateTaxRate: STATE_RATE,
      localTaxRate: LOCAL_RATE,
      stateTaxDue,
      localTaxDue,
      totalTaxDue,
    },
    inputs: { taxablePurchases },
    diagnostics: {
      totalTransactions: rows.length,
      taxableTransactions: taxableTxns,
      summedTaxCollected: round2(taxCents / 100),
      combinedRate: COMBINED_RATE,
      monthsCovered,
      feedStart: TN_FEED_START,
      partialYear: monthsCovered.length < 12,
    },
    feedAsOf: freshRes.rows[0]?.as_of ?? null,
  };
}
