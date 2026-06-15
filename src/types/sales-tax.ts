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
  /** Calendar year the loaded county surtax rates (DR-15DSS) are valid for */
  surtaxTaxYear: number;
  /** True when the filing month's year is past surtaxTaxYear — rates need refreshing */
  surtaxStale: boolean;
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

/* ------------------------------------------------------------------ */
/* Texas Sales & Use Tax (WebFile / 01-114) — two returns, one per     */
/* entity/permit. See docs/superpowers/specs/2026-06-15-texas-sales-tax.md */
/* ------------------------------------------------------------------ */

/** How a return's local tax is sourced — drives the jurisdiction line(s). */
export type TxLocalKind =
  | 'single' // remote seller, single local use tax rate (one flat line)
  | 'origin'; // in-state seller, origin-sourced to its place of business

/** One local-tax jurisdiction line on the Texas return / WebFile "list". */
export interface TxLocalLine {
  /** Comptroller jurisdiction code (e.g. '2220237'); '' for the single rate line */
  code: string;
  /** Jurisdiction name as it reads on the return */
  name: string;
  /** Local rate as a decimal (e.g. 0.0175, 0.015) */
  rate: number;
  /** Amount subject to local tax (whole dollars) */
  amountSubjectToLocal: number;
  /** Local tax due for this jurisdiction (dollars) */
  localTaxDue: number;
}

export interface TxReturnBoxes {
  /** Filing period, e.g. '2026-Q2' */
  period: string;
  /** Item 1 — Total Texas Sales = Σ Subtotal (whole dollars) */
  totalTexasSales: number;
  /** Item 2 — Taxable Sales = backout Σ min(subtotal, tax÷rate) (whole dollars) */
  taxableSales: number;
  /** Item 3 — Taxable Purchases (use tax, whole dollars) */
  taxablePurchases: number;
  /** Amount Subject to State Tax = taxableSales + taxablePurchases */
  subjectToStateTax: number;
  /** State rate (0.0625) */
  stateTaxRate: number;
  /** State Tax Due = subjectToStateTax × 0.0625 */
  stateTaxDue: number;
  /** Local jurisdiction lines (one for single-rate, two for Colleyville origin) */
  localLines: TxLocalLine[];
  /** Combined local rate (Σ of localLines' rates) */
  combinedLocalRate: number;
  /** Total local tax due (Σ localLines) */
  totalLocalTaxDue: number;
  /** Total Tax Due = state + local */
  totalTaxDue: number;
  /** Timely-filing discount = Total Tax Due × 0.005 */
  timelyFilingDiscount: number;
  /** Net Tax Due = Total Tax Due − discount */
  netTaxDue: number;
}

export interface TxReturnInputs {
  /** Taxable purchases for use tax (whole dollars, usually 0) */
  taxablePurchases: number;
}

export interface TxReturnDiagnostics {
  totalTransactions: number;
  taxableTransactions: number;
  /** Exact summed Subtotal before whole-dollar rounding */
  summedSubtotalExact: number;
  /** Exact tax actually collected by LifeFile (for the over/under-collection note) */
  summedTaxCollected: number;
  /** Exact backed-out taxable base before rounding */
  taxableBaseExact: number;
  /** Combined state+local rate used for the backout (e.g. 0.08, 0.0825) */
  combinedRate: number;
  /** Months actually included after the permit-start floor, e.g. ['02','03'] */
  monthsCovered: string[];
  /** Permit-start floor applied (YYYY-MM) */
  permitStart: string;
  /** Destination jurisdictions of the taxable orders (informational / nexus) */
  taxableDestinations: { county: string; transactions: number }[];
}

export interface TxReturnResponse {
  period: string;
  /** Which return this is (location + state + form), enforced server-side */
  filing: SalesTaxFiling;
  /** How local tax is sourced for this return */
  localKind: TxLocalKind;
  boxes: TxReturnBoxes;
  inputs: TxReturnInputs;
  diagnostics: TxReturnDiagnostics;
  feedAsOf: string | null;
}

/* ------------------------------------------------------------------ */
/* Tennessee Sales & Use Tax (SLS-450) — MedRock Tennessee, annual.    */
/* See docs/superpowers/specs/2026-06-15-tennessee-sales-tax.md        */
/* ------------------------------------------------------------------ */

export interface TnReturnBoxes {
  /** Filing year, e.g. '2026' (period ending 12/31) */
  period: string;
  /** Line 1 — Gross Sales = Σ Subtotal */
  grossSales: number;
  /** Taxable Sales = Σ Tax ÷ combined rate (SOP backout) */
  taxableSales: number;
  /** Taxable purchases (use tax, Line 2) — usually 0 */
  taxablePurchases: number;
  /** Exempt / deductions = Gross Sales − Taxable Sales */
  exemptSales: number;
  /** State rate (0.07) */
  stateTaxRate: number;
  /** Local rate (0.0225 — Hamilton Co.) */
  localTaxRate: number;
  /** State tax = (taxableSales + taxablePurchases) × stateTaxRate */
  stateTaxDue: number;
  /** Local tax = (taxableSales + taxablePurchases) × localTaxRate */
  localTaxDue: number;
  /** Total tax = state + local (ties to tax collected by construction) */
  totalTaxDue: number;
}

export interface TnReturnInputs {
  taxablePurchases: number;
}

export interface TnReturnDiagnostics {
  totalTransactions: number;
  taxableTransactions: number;
  /** Tax actually collected by LifeFile (= totalTaxDue by construction) */
  summedTaxCollected: number;
  /** Combined state+local rate used for the backout (0.0925) */
  combinedRate: number;
  /** Months present in the feed for the year, e.g. ['01',...,'06'] */
  monthsCovered: string[];
  /** Earliest month the feed carries (TN sales before this predate the feed) */
  feedStart: string;
  /** True when the selected year is still in progress (not all 12 months present) */
  partialYear: boolean;
}

export interface TnReturnResponse {
  period: string;
  filing: SalesTaxFiling;
  boxes: TnReturnBoxes;
  inputs: TnReturnInputs;
  diagnostics: TnReturnDiagnostics;
  feedAsOf: string | null;
}
