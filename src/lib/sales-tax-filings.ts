/**
 * Sales-tax filing registry — the single source of truth for the sidebar nav AND
 * the per-filing page headers. Each MedRock location is its own filing entity; a
 * return is one (entity, ship-to state, form) with its own cadence + due date.
 *
 * Confirmed filing matrix (Carson 2026-06-15):
 *   MedRock Florida   -> FL (DR-15) + TX
 *   MedRock Texas     -> TX
 *   MedRock Tennessee -> TN  (TN only; other states it ships are non-taxable Rx)
 *   => exactly 4 active returns; TX is filed twice (FL entity + TX entity).
 * Legacy GA/NC registrations keep filing until formally closed (see legacy list).
 */

export interface TaxFiling {
  /** Route slug under /sales-tax (e.g. 'florida/fl') */
  slug: string;
  /** Filing entity = pharmacy location (matches source.sales_tax_report 'Location') */
  entity: string;
  /** Ship-to state full name */
  stateName: string;
  /** Ship-to state abbreviation */
  stateAbbr: string;
  /** Return / form name */
  form: string;
  /** Filing cadence, e.g. 'Monthly' / 'Annual' */
  cadence: string;
  /** Plain-English due date / deadline rule */
  due: string;
  /** True when the on-site generator is built; false = placeholder (build-later) */
  built: boolean;
}

export interface TaxLocationGroup {
  /** Filing entity / pharmacy location */
  entity: string;
  /** Short label for the sidebar group */
  short: string;
  filings: TaxFiling[];
}

const DUE_20TH = 'Due the 20th of the following month (file & pay by the prior business day if the 20th is a weekend or holiday).';
const DUE_TX_QUARTERLY = 'Quarterly — due the 20th of the month after each quarter ends (Apr 20, Jul 20, Oct 20, Jan 20); file by the prior business day if it falls on a weekend or holiday.';
const DUE_TN_ANNUAL = 'Annual — covers the calendar year; due January 20 (the 20th of the month after the period ends); file by the prior business day if it falls on a weekend or holiday.';

export const TAX_LOCATION_GROUPS: TaxLocationGroup[] = [
  {
    entity: 'MedRock Florida',
    short: 'Florida',
    filings: [
      {
        slug: 'florida/fl',
        entity: 'MedRock Florida',
        stateName: 'Florida',
        stateAbbr: 'FL',
        form: 'DR-15',
        cadence: 'Monthly',
        due: DUE_20TH,
        built: true,
      },
      {
        slug: 'florida/tx',
        entity: 'MedRock Florida',
        stateName: 'Texas',
        stateAbbr: 'TX',
        form: 'Texas Sales & Use Tax (WebFile / 01-114)',
        cadence: 'Quarterly',
        due: DUE_TX_QUARTERLY,
        built: false,
      },
    ],
  },
  {
    entity: 'MedRock Texas',
    short: 'Texas',
    filings: [
      {
        slug: 'texas/tx',
        entity: 'MedRock Texas',
        stateName: 'Texas',
        stateAbbr: 'TX',
        form: 'Texas Sales & Use Tax (WebFile / 01-114)',
        cadence: 'Quarterly',
        due: DUE_TX_QUARTERLY,
        built: false,
      },
    ],
  },
  {
    entity: 'MedRock Tennessee',
    short: 'Tennessee',
    filings: [
      {
        slug: 'tennessee/tn',
        entity: 'MedRock Tennessee',
        stateName: 'Tennessee',
        stateAbbr: 'TN',
        form: 'SLS-450',
        cadence: 'Annual',
        due: DUE_TN_ANNUAL,
        built: false,
      },
    ],
  },
];

/**
 * Legacy registrations from the prior accountant. Outside the FL/TX/TN model, but
 * must keep filing (even $0) until formally closed — do not silently stop. Pending
 * Carson's decision to retire or migrate onto the feed.
 */
export const TAX_LEGACY_FILINGS: TaxFiling[] = [
  {
    slug: 'ga',
    entity: 'Legacy registration',
    stateName: 'Georgia',
    stateAbbr: 'GA',
    form: 'GA ST-3',
    cadence: 'Annual',
    due: 'Annual — keep filing until the registration is formally closed.',
    built: false,
  },
  {
    slug: 'nc',
    entity: 'Legacy registration',
    stateName: 'North Carolina',
    stateAbbr: 'NC',
    form: 'E-500',
    cadence: 'Monthly',
    due: 'Due the 20th of the following month — keep filing until the registration is formally closed.',
    built: false,
  },
];

/** Flat lookup of every filing by slug (active + legacy). */
export const ALL_FILINGS: TaxFiling[] = [
  ...TAX_LOCATION_GROUPS.flatMap((g) => g.filings),
  ...TAX_LEGACY_FILINGS,
];

export function getFiling(slug: string): TaxFiling | undefined {
  return ALL_FILINGS.find((f) => f.slug === slug);
}
