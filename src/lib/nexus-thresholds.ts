/**
 * US state economic-nexus thresholds (post-Wayfair), as of 2026-06-17.
 *
 * Source of record: docs/tax-reference/economic-nexus-thresholds-by-state.md
 * (cross-verified against Sales Tax Institute, Avalara, TaxJar, TaxCloud, Numeral).
 *
 * Used by the Nexus Exposure dashboard to compare MedRock's actual ship-to sales
 * (source.sales_tax_report) against each state's threshold.
 *
 * NOTE on `salesBasis`: most states measure the threshold on GROSS sales (all sales
 * including exempt Rx); a few measure TAXABLE sales only (FL, MO). The dashboard
 * compares gross sales by default and flags the taxable-basis states so the (much
 * lower, Rx-exempt) real figure is not misread. Where a state's exact basis is not
 * verified to a 2026 primary source we default to 'gross' — the larger denominator,
 * i.e. the conservative direction for an exposure screen.
 */

/** How the sales and transaction prongs combine. */
export type NexusCombine = 'or' | 'and' | 'sales_only';
/** Which sales figure the threshold measures. */
export type NexusSalesBasis = 'gross' | 'taxable';

export interface StateThreshold {
  abbr: string;
  name: string;
  /** False for the 5 states with no general state sales tax. */
  hasSalesTax: boolean;
  /** Dollar threshold; null when the state has no sales tax. */
  salesThreshold: number | null;
  /** Transaction-count threshold; null when none / repealed. */
  txnThreshold: number | null;
  combine: NexusCombine;
  salesBasis: NexusSalesBasis;
  /** Short human-readable measurement period. */
  measurement: string;
  /** Short caveat (repeal date, AND rule, no-tax note, etc.). */
  note?: string;
}

const T = (
  abbr: string,
  name: string,
  salesThreshold: number | null,
  txnThreshold: number | null,
  combine: NexusCombine,
  measurement: string,
  opts: { salesBasis?: NexusSalesBasis; hasSalesTax?: boolean; note?: string } = {},
): StateThreshold => ({
  abbr,
  name,
  hasSalesTax: opts.hasSalesTax ?? true,
  salesThreshold,
  txnThreshold,
  combine,
  salesBasis: opts.salesBasis ?? 'gross',
  measurement,
  note: opts.note,
});

export const STATE_THRESHOLDS: StateThreshold[] = [
  T('AL', 'Alabama', 250000, null, 'sales_only', 'Previous calendar year', { note: 'Retail (TPP) sales; marketplace excluded.' }),
  T('AK', 'Alaska', 100000, null, 'sales_only', 'Current or previous CY', { note: 'No STATE tax — local only via ARSSTC; 200-txn prong repealed 1/1/2025.' }),
  T('AZ', 'Arizona', 100000, null, 'sales_only', 'Previous or current CY'),
  T('AR', 'Arkansas', 100000, 200, 'or', 'Previous or current CY', { note: 'Txn prong not verified to a 2026 DOR source.' }),
  T('CA', 'California', 500000, null, 'sales_only', 'Preceding or current CY', { note: 'TPP only; txn prong repealed 2019.' }),
  T('CO', 'Colorado', 100000, null, 'sales_only', 'Previous or current CY'),
  T('CT', 'Connecticut', 100000, 200, 'and', '12-mo ending Sep 30', { note: 'BOTH thresholds required (AND).' }),
  T('DE', 'Delaware', null, null, 'sales_only', '—', { hasSalesTax: false, note: 'No sales tax.' }),
  T('DC', 'District of Columbia', 100000, 200, 'or', 'Previous or current CY'),
  T('FL', 'Florida', 100000, null, 'sales_only', 'Previous calendar year', { salesBasis: 'taxable', note: 'Threshold is TAXABLE remote sales — exempt Rx likely excluded.' }),
  T('GA', 'Georgia', 100000, 200, 'or', 'Previous or current CY', { note: 'Txn prong still active — 200 individual shipments can trigger nexus before $.' }),
  T('HI', 'Hawaii', 100000, 200, 'or', 'Current or preceding CY', { note: 'GET, not sales tax; marketplace counts toward seller threshold.' }),
  T('ID', 'Idaho', 100000, null, 'sales_only', 'Previous or current CY'),
  T('IL', 'Illinois', 100000, null, 'sales_only', 'Preceding 12 months', { note: 'Txn prong repealed 1/1/2026. IL taxes Rx at 1% — Rx sales DO count.' }),
  T('IN', 'Indiana', 100000, null, 'sales_only', 'CY of txn or preceding', { note: 'Txn prong repealed 1/1/2024.' }),
  T('IA', 'Iowa', 100000, null, 'sales_only', 'Current or preceding CY', { note: 'Txn prong repealed 2019.' }),
  T('KS', 'Kansas', 100000, null, 'sales_only', 'Current or preceding CY'),
  T('KY', 'Kentucky', 100000, 200, 'or', 'Previous or current CY', { note: 'Txn prong repealed 8/1/2026 (upcoming) — sales-only after.' }),
  T('LA', 'Louisiana', 100000, null, 'sales_only', 'Previous or current CY', { note: 'Txn prong repealed 8/1/2023.' }),
  T('ME', 'Maine', 100000, null, 'sales_only', 'Previous or current CY', { note: 'Txn prong repealed 1/1/2022.' }),
  T('MD', 'Maryland', 100000, 200, 'or', 'Previous or current CY'),
  T('MA', 'Massachusetts', 100000, null, 'sales_only', 'Previous or current CY', { note: 'Txn prong repealed 10/1/2019; marketplace excluded.' }),
  T('MI', 'Michigan', 100000, 200, 'or', 'Previous CY'),
  T('MN', 'Minnesota', 100000, 200, 'or', '12-mo ending last day of recent quarter'),
  T('MS', 'Mississippi', 250000, null, 'sales_only', 'Prior 12 months'),
  T('MO', 'Missouri', 100000, null, 'sales_only', 'Previous 12 mo (quarterly review)', { salesBasis: 'taxable', note: 'Threshold is TAXABLE sales only.' }),
  T('MT', 'Montana', null, null, 'sales_only', '—', { hasSalesTax: false, note: 'No sales tax.' }),
  T('NE', 'Nebraska', 100000, 200, 'or', 'Previous or current CY'),
  T('NV', 'Nevada', 100000, 200, 'or', 'Previous or current CY'),
  T('NH', 'New Hampshire', null, null, 'sales_only', '—', { hasSalesTax: false, note: 'No sales tax.' }),
  T('NJ', 'New Jersey', 100000, 200, 'or', 'Previous or current CY'),
  T('NM', 'New Mexico', 100000, null, 'sales_only', 'Previous CY', { note: 'Gross Receipts Tax.' }),
  T('NY', 'New York', 500000, 100, 'and', 'Preceding four sales-tax quarters', { note: 'BOTH required (AND); 100 txns.' }),
  T('NC', 'North Carolina', 100000, null, 'sales_only', 'Previous or current CY', { note: 'Txn prong repealed 7/1/2024; broadest gross definition.' }),
  T('ND', 'North Dakota', 100000, null, 'sales_only', 'Previous or current CY', { note: 'Txn prong repealed 2018.' }),
  T('OH', 'Ohio', 100000, 200, 'or', 'Previous or current CY'),
  T('OK', 'Oklahoma', 100000, null, 'sales_only', 'Preceding or current CY'),
  T('OR', 'Oregon', null, null, 'sales_only', '—', { hasSalesTax: false, note: 'No sales tax.' }),
  T('PA', 'Pennsylvania', 100000, null, 'sales_only', 'Prior CY'),
  T('RI', 'Rhode Island', 100000, 200, 'or', 'Preceding CY'),
  T('SC', 'South Carolina', 100000, null, 'sales_only', 'Previous or current CY'),
  T('SD', 'South Dakota', 100000, null, 'sales_only', 'Previous or current CY', { note: 'Txn prong repealed 7/1/2023.' }),
  T('TN', 'Tennessee', 100000, null, 'sales_only', 'Previous 12 months', { note: 'Gross retail (taxable + nontaxable); wholesale/marketplace excluded.' }),
  T('TX', 'Texas', 500000, null, 'sales_only', 'Preceding 12 calendar months (rolling)', { note: 'Gross; Rx counts even though exempt.' }),
  T('UT', 'Utah', 100000, null, 'sales_only', 'Previous or current CY', { note: 'Txn prong repealed 7/1/2025.' }),
  T('VT', 'Vermont', 100000, 200, 'or', 'Prior four calendar quarters'),
  T('VA', 'Virginia', 100000, 200, 'or', 'Previous or current CY'),
  T('WA', 'Washington', 100000, null, 'sales_only', 'Current or preceding CY', { note: 'Txn prong repealed 2019.' }),
  T('WV', 'West Virginia', 100000, 200, 'or', 'Preceding or current CY'),
  T('WI', 'Wisconsin', 100000, null, 'sales_only', 'Previous or current CY', { note: 'Txn prong repealed 2021.' }),
  T('WY', 'Wyoming', 100000, null, 'sales_only', 'Previous or current CY', { note: 'Txn prong repealed 7/1/2024.' }),
];

export const THRESHOLD_BY_ABBR: Record<string, StateThreshold> = Object.fromEntries(
  STATE_THRESHOLDS.map((t) => [t.abbr, t]),
);
