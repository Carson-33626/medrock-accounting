/**
 * Types for the Florida sales-tax (DR-15) generator.
 * Source data: AWS RDS source.sales_tax_report (LifeFile Sales Tax Report feed).
 * Method reverse-engineered from the accountant's "Sales Tax Workbook" .xlsx.
 */

export interface FlDr15Boxes {
  month: string; // YYYY-MM
  /** Box 1 — Gross Sales = total sales basis - total tax due */
  box1_gross: number;
  /** Box 2 — Exempt Sales = Box 1 - Box 3 */
  box2_exempt: number;
  /** Box 3 — Total Taxable Amount = taxable sales + taxable purchases */
  box3_taxable: number;
  /** Box 4 — Total Tax Due = tax collected + use tax on purchases */
  box4_tax: number;
  /** Box B — Discretionary surtax (memo) = Box 3 x 1% */
  boxB_surtax: number;
  /** Box 8a — Collection allowance = 2.5% of first $1,200 of tax, max $30 */
  box8a_allowance: number;
}

export interface FlDr15Inputs {
  /** Total sales basis (B4). Defaults to summed FL Subtotal; user may override with the bank deposit. */
  salesBasis: number;
  /** Source of salesBasis: 'sales_sum' (computed) or 'bank_statement' (manual override) */
  salesBasisSource: 'sales_sum' | 'bank_statement';
  /** Taxable sales from the feed (E4), county-rate backout */
  taxableSales: number;
  /** Tax collected from the feed (F4) */
  taxCollected: number;
  /** Total taxable purchases for use tax (E7) — manual from QB, usually 0 */
  taxablePurchases: number;
  /** Sales/use tax on purchases (F7) = taxablePurchases x 8.5% */
  salesUseTax: number;
}

export interface FlDr15Diagnostics {
  totalTransactions: number;
  taxableTransactions: number;
  summedSubtotal: number;
  summedTotalSales: number;
  /** Taxable rows whose county was unknown and used the default surtax */
  unknownCountyRows: number;
  /** Alternative flat-rate taxable base for comparison (tax / flatRate) */
  flatRateTaxableBase: number;
  flatRate: number;
  shipToStates: { state: string; transactions: number; sales: number }[];
}

/**
 * Identifies exactly which return this is. Each MedRock location is its own
 * filing entity; a return is scoped by (location origin, ship-to state, form).
 * Surfaced + enforced so a FL DR-15 can never silently include another
 * location's sales. The (location x state) matrix also yields the two separate
 * TX returns: MedRock Florida -> TX and MedRock Texas -> TX.
 */
export interface SalesTaxFiling {
  /** Origin location / filing entity — matches source.sales_tax_report 'Location' */
  location: string;
  /** Ship-to state this return covers (destination basis) */
  filingState: string;
  /** Form name, e.g. 'DR-15' (FL) */
  form: string;
}

export interface FlDr15Response {
  month: string;
  /** Which return this is (location + state + form), enforced server-side */
  filing: SalesTaxFiling;
  boxes: FlDr15Boxes;
  inputs: FlDr15Inputs;
  diagnostics: FlDr15Diagnostics;
  /** Latest ingested_at of the feed, so the UI can show data freshness */
  feedAsOf: string | null;
}
