/**
 * Florida discretionary sales surtax rates by county, calendar year 2026.
 * Source: FL DR-15DSS R.11/25 (floridarevenue.com/Forms_library/current/dr15dss_26.pdf).
 * Keyed by 5-digit county FIPS (source.sales_tax_report carries Patient County FIPS).
 * Canonical copy + provenance: Accounting-Analytics/data/fl_county_surtax_rates.json.
 *
 * Used to back out the DR-15 taxable base (Box 3) per transaction:
 *   taxable_base = tax_collected / (FL_STATE_RATE + countySurtax(fips))
 * which correctly handles partially-taxable orders (where the LifeFile Subtotal
 * includes exempt items alongside the taxed ones).
 */

export const FL_STATE_RATE = 0.06;
/** Fallback surtax when a transaction has no/unknown county (logged by callers). */
export const FL_DEFAULT_SURTAX = 0.01;

/**
 * Calendar year these county surtax rates are valid for.
 * DATED REMINDER: refresh from the next DR-15DSS when FL publishes it (~January each
 * year). For CY2027, pull `dr15dss_27.pdf`, update FL_SURTAX_BY_FIPS, and bump this to
 * 2027 — do it around January 2027. The sales-tax page auto-flags whenever a selected
 * filing month falls in a year past this one, so a stale table can't go unnoticed.
 */
export const FL_SURTAX_TAX_YEAR = 2026;

/** FIPS -> { county, surtax (decimal) } for CY2026. */
export const FL_SURTAX_BY_FIPS: Record<string, { county: string; surtax: number }> = {
  '12001': { county: 'Alachua', surtax: 0.015 },
  '12003': { county: 'Baker', surtax: 0.01 },
  '12005': { county: 'Bay', surtax: 0.01 },
  '12007': { county: 'Bradford', surtax: 0.01 },
  '12009': { county: 'Brevard', surtax: 0.01 },
  '12011': { county: 'Broward', surtax: 0.01 },
  '12013': { county: 'Calhoun', surtax: 0.015 },
  '12015': { county: 'Charlotte', surtax: 0.01 },
  '12017': { county: 'Citrus', surtax: 0.0 },
  '12019': { county: 'Clay', surtax: 0.015 },
  '12021': { county: 'Collier', surtax: 0.0 },
  '12023': { county: 'Columbia', surtax: 0.015 },
  '12027': { county: 'DeSoto', surtax: 0.015 },
  '12029': { county: 'Dixie', surtax: 0.01 },
  '12031': { county: 'Duval', surtax: 0.015 },
  '12033': { county: 'Escambia', surtax: 0.015 },
  '12035': { county: 'Flagler', surtax: 0.01 },
  '12037': { county: 'Franklin', surtax: 0.015 },
  '12039': { county: 'Gadsden', surtax: 0.015 },
  '12041': { county: 'Gilchrist', surtax: 0.01 },
  '12043': { county: 'Glades', surtax: 0.01 },
  '12045': { county: 'Gulf', surtax: 0.01 },
  '12047': { county: 'Hamilton', surtax: 0.02 },
  '12049': { county: 'Hardee', surtax: 0.01 },
  '12051': { county: 'Hendry', surtax: 0.015 },
  '12053': { county: 'Hernando', surtax: 0.005 },
  '12055': { county: 'Highlands', surtax: 0.015 },
  '12057': { county: 'Hillsborough', surtax: 0.015 },
  '12059': { county: 'Holmes', surtax: 0.015 },
  '12061': { county: 'Indian River', surtax: 0.01 },
  '12063': { county: 'Jackson', surtax: 0.015 },
  '12065': { county: 'Jefferson', surtax: 0.01 },
  '12067': { county: 'Lafayette', surtax: 0.01 },
  '12069': { county: 'Lake', surtax: 0.01 },
  '12071': { county: 'Lee', surtax: 0.005 },
  '12073': { county: 'Leon', surtax: 0.015 },
  '12075': { county: 'Levy', surtax: 0.01 },
  '12077': { county: 'Liberty', surtax: 0.015 },
  '12079': { county: 'Madison', surtax: 0.015 },
  '12081': { county: 'Manatee', surtax: 0.01 },
  '12083': { county: 'Marion', surtax: 0.015 },
  '12085': { county: 'Martin', surtax: 0.005 },
  '12086': { county: 'Miami-Dade', surtax: 0.01 },
  '12087': { county: 'Monroe', surtax: 0.015 },
  '12089': { county: 'Nassau', surtax: 0.01 },
  '12091': { county: 'Okaloosa', surtax: 0.01 },
  '12093': { county: 'Okeechobee', surtax: 0.01 },
  '12095': { county: 'Orange', surtax: 0.005 },
  '12097': { county: 'Osceola', surtax: 0.015 },
  '12099': { county: 'Palm Beach', surtax: 0.005 },
  '12101': { county: 'Pasco', surtax: 0.01 },
  '12103': { county: 'Pinellas', surtax: 0.01 },
  '12105': { county: 'Polk', surtax: 0.01 },
  '12107': { county: 'Putnam', surtax: 0.01 },
  '12109': { county: 'St. Johns', surtax: 0.005 },
  '12111': { county: 'St. Lucie', surtax: 0.01 },
  '12113': { county: 'Santa Rosa', surtax: 0.01 },
  '12115': { county: 'Sarasota', surtax: 0.01 },
  '12117': { county: 'Seminole', surtax: 0.01 },
  '12119': { county: 'Sumter', surtax: 0.01 },
  '12121': { county: 'Suwannee', surtax: 0.01 },
  '12123': { county: 'Taylor', surtax: 0.01 },
  '12125': { county: 'Union', surtax: 0.01 },
  '12127': { county: 'Volusia', surtax: 0.005 },
  '12129': { county: 'Wakulla', surtax: 0.015 },
  '12131': { county: 'Walton', surtax: 0.01 },
  '12133': { county: 'Washington', surtax: 0.015 },
};

/** Combined FL rate (state + county surtax) for a FIPS; FL_DEFAULT_SURTAX if unknown. */
export function flCombinedRate(fips: string | null | undefined): number {
  const entry = fips ? FL_SURTAX_BY_FIPS[fips.trim()] : undefined;
  return FL_STATE_RATE + (entry ? entry.surtax : FL_DEFAULT_SURTAX);
}

export function flCountyKnown(fips: string | null | undefined): boolean {
  return !!(fips && FL_SURTAX_BY_FIPS[fips.trim()]);
}
