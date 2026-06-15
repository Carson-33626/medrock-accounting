/**
 * Texas Sales & Use Tax return computation from the RDS feed (source.sales_tax_report).
 *
 * Two returns, one per entity/permit (Texas is filed twice). Both quarterly, both via the
 * Comptroller eSystems/WebFile portal. Method + calibration: see
 * docs/superpowers/specs/2026-06-15-texas-sales-tax.md.
 *
 *   - Scope: Location = <entity> AND Patient State = 'TX', within the quarter, floored at the
 *     permit start 2026-02-01 (both permits went effective Feb 2026 — Q1 2026 = Feb+Mar only).
 *   - Total Texas Sales (Item 1) = round(Σ Subtotal)  [whole dollars] — calibrated to the filed
 *     Q1 returns to the dollar (290,176 / 137,088).
 *   - Taxable Sales (Item 2) = round(Σ per-txn min(subtotal, tax ÷ combinedRate))  [backout,
 *     capped at the order subtotal] — the same logic as FL DR-15; isolates the taxable portion of
 *     partially-exempt Rx orders. Reproduces the TX-entity filed taxable (69) exactly.
 *   - Taxable Purchases (Item 3) = manual use-tax input (whole dollars, usually 0).
 *   - State Tax = (Item2 + Item3) × 6.25%; Local = same base × the entity's local rate(s);
 *     Timely-filing discount = 0.5% of total tax due.
 *
 * Local sourcing differs by entity (Carson 2026-06-15):
 *   - MedRock Florida (remote seller): single local use tax rate 1.75% (Form 01-799) → 8.00%.
 *   - MedRock Texas (in-state): origin-sourced to Colleyville (city 1.5% + crime ctrl 0.5%) → 8.25%.
 *
 * All arithmetic in integer cents; whole-dollar rounding only at the WebFile edge.
 */

import { getRdsPool } from './rds';
import type {
  SalesTaxFiling,
  TxLocalKind,
  TxLocalLine,
  TxReturnBoxes,
  TxReturnResponse,
} from '@/types/sales-tax';

const STATE_RATE = 0.0625;
/** Both Texas permits went effective Feb 2026 — never pull pre-Feb sales. */
export const TX_PERMIT_START = '2026-02';

/** A jurisdiction line template (rate is fixed; amount/tax computed per return). */
interface JurisdictionRate {
  code: string;
  name: string;
  rate: number;
}

interface TxReturnConfig {
  filing: SalesTaxFiling;
  localKind: TxLocalKind;
  /** Jurisdiction rate lines (one for single-rate, two for Colleyville origin). */
  jurisdictions: JurisdictionRate[];
}

/** Registry of the two Texas returns, keyed by route slug. */
export const TX_RETURNS: Record<string, TxReturnConfig> = {
  'florida/tx': {
    filing: { location: 'MedRock Florida', filingState: 'TX', form: '01-114' },
    localKind: 'single',
    // Remote seller single local use tax rate (published in the Texas Register; 1.75% since 2019).
    jurisdictions: [{ code: '', name: 'Single Local Use Tax Rate', rate: 0.0175 }],
  },
  'texas/tx': {
    filing: { location: 'MedRock Texas', filingState: 'TX', form: '01-114' },
    localKind: 'origin',
    // In-state seller, origin-sourced to its place of business (Colleyville).
    jurisdictions: [
      { code: '2220237', name: 'COLLEYVILLE-CITY', rate: 0.015 },
      { code: '5220629', name: 'COLLEYVILLE CRIME CONTROL', rate: 0.005 },
    ],
  },
};

export function getTxReturnConfig(slug: string): TxReturnConfig | undefined {
  return TX_RETURNS[slug];
}

/** One source transaction for the export (no street address — minimize PHI). */
export interface TxSourceRow {
  tx_id: string;
  date: string;
  city: string;
  county: string;
  fips: string;
  zip: string;
  subtotal: number;
  tax: number;
  total_sales: number;
  taxable_base: number;
}

const PERIOD_RE = /^(\d{4})-Q([1-4])$/;

/** Months ('MM') of a quarter, floored at the permit start. Throws on a bad period. */
export function monthsForPeriod(period: string): { year: string; months: string[] } {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error(`Invalid period: ${period} (expected YYYY-Qn)`);
  const year = m[1];
  const q = Number(m[2]);
  const all = [1, 2, 3].map((i) => String((q - 1) * 3 + i).padStart(2, '0'));
  const [floorY, floorM] = TX_PERMIT_START.split('-');
  const months = all.filter((mm) => year > floorY || (year === floorY && mm >= floorM));
  return { year, months };
}

const num = (s: string | null): number => {
  const v = parseFloat((s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(v) ? v : 0;
};

interface FeedRow {
  tx_id: string;
  date: string;
  city: string;
  county: string;
  fips: string;
  zip: string;
  subtotal: number;
  tax: number;
  total_sales: number;
}

async function fetchRows(location: string, period: string): Promise<FeedRow[]> {
  const { year, months } = monthsForPeriod(period);
  if (months.length === 0) return [];
  const patterns = months.map((mm) => `${mm}/%/${year}`);
  const pool = getRdsPool();
  const res = await pool.query<{
    tx_id: string | null;
    date: string | null;
    city: string | null;
    county: string | null;
    fips: string | null;
    zip: string | null;
    subtotal: string | null;
    tax: string | null;
    total_sales: string | null;
  }>(
    `SELECT row_data->>'Tx ID' AS tx_id, row_data->>'Tx Effective Date' AS date,
            row_data->>'Patient City' AS city, row_data->>'Patient County' AS county,
            row_data->>'Patient County FIPS' AS fips, row_data->>'Patient ZIP' AS zip,
            row_data->>'Subtotal' AS subtotal, row_data->>'Tax' AS tax,
            row_data->>'Total Sales' AS total_sales
     FROM source.sales_tax_report
     WHERE row_data->>'Location' = $1
       AND row_data->>'Patient State' = 'TX'
       AND row_data->>'Tx Effective Date' LIKE ANY($2::text[])
     ORDER BY row_data->>'Tx Effective Date', row_data->>'Tx ID'`,
    [location, patterns],
  );
  return res.rows.map((r) => ({
    tx_id: r.tx_id ?? '',
    date: r.date ?? '',
    city: r.city ?? '',
    county: r.county ?? '',
    fips: r.fips ?? '',
    zip: r.zip ?? '',
    subtotal: num(r.subtotal),
    tax: num(r.tax),
    total_sales: num(r.total_sales),
  }));
}

/** Fetch the TX source transactions for a return + period, for export. */
export async function fetchTxSourceRows(slug: string, period: string): Promise<TxSourceRow[]> {
  const cfg = getTxReturnConfig(slug);
  if (!cfg) throw new Error(`Unknown Texas return: ${slug}`);
  const combined = STATE_RATE + cfg.jurisdictions.reduce((s, j) => s + j.rate, 0);
  const rows = await fetchRows(cfg.filing.location, period);
  return rows.map((r) => {
    const taxCents = Math.round(r.tax * 100);
    const subCents = Math.round(r.subtotal * 100);
    return {
      tx_id: r.tx_id,
      date: r.date,
      city: r.city,
      county: r.county,
      fips: r.fips,
      zip: r.zip,
      subtotal: r.subtotal,
      tax: r.tax,
      total_sales: r.total_sales,
      taxable_base: taxCents > 0 ? Math.min(subCents, Math.round(taxCents / combined)) / 100 : 0,
    };
  });
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export async function computeTxReturn(
  slug: string,
  period: string,
  opts: { taxablePurchases?: number } = {},
): Promise<TxReturnResponse> {
  const cfg = getTxReturnConfig(slug);
  if (!cfg) throw new Error(`Unknown Texas return: ${slug}`);
  const combinedLocalRate = cfg.jurisdictions.reduce((s, j) => s + j.rate, 0);
  const combinedRate = STATE_RATE + combinedLocalRate;

  const { months } = monthsForPeriod(period);
  const rows = await fetchRows(cfg.filing.location, period);

  let subtotalCents = 0;
  let taxCents = 0;
  let taxableBaseCents = 0;
  let taxableTxns = 0;
  const destAgg = new Map<string, number>();

  for (const r of rows) {
    const sc = Math.round(r.subtotal * 100);
    const tc = Math.round(r.tax * 100);
    subtotalCents += sc;
    taxCents += tc;
    if (tc > 0) {
      taxableTxns += 1;
      taxableBaseCents += Math.min(sc, Math.round(tc / combinedRate));
      const county = r.county || '(unknown)';
      destAgg.set(county, (destAgg.get(county) ?? 0) + 1);
    }
  }

  // Whole-dollar WebFile values
  const totalTexasSales = Math.round(subtotalCents / 100);
  const taxableSales = Math.round(taxableBaseCents / 100);
  const taxablePurchases = Math.max(0, Math.round(opts.taxablePurchases ?? 0));
  const subjectToStateTax = taxableSales + taxablePurchases;

  const stateTaxDue = round2(subjectToStateTax * STATE_RATE);
  const localLines: TxLocalLine[] = cfg.jurisdictions.map((j) => ({
    code: j.code,
    name: j.name,
    rate: j.rate,
    amountSubjectToLocal: subjectToStateTax,
    localTaxDue: round2(subjectToStateTax * j.rate),
  }));
  const totalLocalTaxDue = round2(localLines.reduce((s, l) => s + l.localTaxDue, 0));
  const totalTaxDue = round2(stateTaxDue + totalLocalTaxDue);
  const timelyFilingDiscount = round2(totalTaxDue * 0.005);
  const netTaxDue = round2(totalTaxDue - timelyFilingDiscount);

  const boxes: TxReturnBoxes = {
    period,
    totalTexasSales,
    taxableSales,
    taxablePurchases,
    subjectToStateTax,
    stateTaxRate: STATE_RATE,
    stateTaxDue,
    localLines,
    combinedLocalRate,
    totalLocalTaxDue,
    totalTaxDue,
    timelyFilingDiscount,
    netTaxDue,
  };

  const freshRes = await getRdsPool().query<{ as_of: string | null }>(
    `SELECT max(ingested_at)::text AS as_of FROM source.sales_tax_report`,
  );

  const taxableDestinations = [...destAgg.entries()]
    .map(([county, transactions]) => ({ county, transactions }))
    .sort((a, b) => b.transactions - a.transactions);

  return {
    period,
    filing: cfg.filing,
    localKind: cfg.localKind,
    boxes,
    inputs: { taxablePurchases },
    diagnostics: {
      totalTransactions: rows.length,
      taxableTransactions: taxableTxns,
      summedSubtotalExact: round2(subtotalCents / 100),
      summedTaxCollected: round2(taxCents / 100),
      taxableBaseExact: round2(taxableBaseCents / 100),
      combinedRate,
      monthsCovered: months,
      permitStart: TX_PERMIT_START,
      taxableDestinations,
    },
    feedAsOf: freshRes.rows[0]?.as_of ?? null,
  };
}
