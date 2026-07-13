/**
 * Pure, data-only seed for accounting.payroll_account_map, transcribed from
 * docs/superpowers/specs/2026-07-10-payroll-mapping-addendum.md ("Seed rules
 * derived from Amy's PR 2026.03.27"). No DB/QB imports — `buildSeedAccountMap`
 * is a plain function of `Entity` so it can be used by both the seeder CLI
 * (scripts/payroll/seed-account-map.ts) and the dry-run reconcile
 * (scripts/payroll/dry-run-reconcile.ts) without any side effects.
 *
 * ADP column strings below were cross-checked against the live
 * source.payroll_history sensitive-key vocabulary (structure only, no PII/
 * amounts read) to catch exact-string gotchas ADP's export has, e.g. the
 * double space in "RI STATE - DISABILITY INSURANCE  EE".
 */
import type { AccountMapRule, CreditBucket, Entity } from '../../src/lib/payroll/types';

const COST_CENTERS = ['LAB', 'PHARM', 'RD', 'ADMIN', 'ACCOUN', 'CS', 'DATA', 'SHIP', 'MARKET'] as const;
type CostCenter = (typeof COST_CENTERS)[number];

// LAB/PHARM/RD are the COGS-role cost centers per the addendum; everyone else
// (ADMIN/ACCOUN/CS/DATA/SHIP/MARKET) posts to non-COGS "Payroll Expense -:" accounts.
const COGS_COST_CENTERS = new Set<CostCenter>(['LAB', 'PHARM', 'RD']);

const REGULAR_EARNING_COLUMNS = [
  'REGULAR PAY - EARNING',
  'HOLIDAY PAY - EARNING',
  'PTO - EARNING',
  'PTO CASHOUT - EARNING',
  'PREM PAY - EARNING',
  'DELIVERY - EARNING',
  'COMMITTEE - EARNING',
  'BEREAVEMENT - EARNING',
] as const;

const OT_EARNING_COLUMNS = ['OVERTIME PREMIUM - EARNING', 'OVERTIME STRAIGHT - EARNING'] as const;

/** Regular-wage account per cost_center (addendum §"Wage earnings" table). */
const REGULAR_WAGE_ACCOUNT: Record<CostCenter, string> = {
  LAB: 'COGS - Payroll Expense:COGS - Lab Wages',
  PHARM: 'COGS - Payroll Expense:COGS - Pharmacists Wages',
  RD: 'COGS - Payroll Expense:COGS - R & D Wages',
  ADMIN: 'Payroll Expense -:Administrative Wages',
  ACCOUN: 'Payroll Expense -:Administrative Wages',
  CS: 'Payroll Expense -:Customer Service Wages',
  DATA: 'Payroll Expense -:Data Entry Wages',
  SHIP: 'Payroll Expense -:Shipping Wages',
  MARKET: 'Payroll Expense -:Marketing Wages - Base',
};

/**
 * OT-wage account per cost_center. PHARM ("(rare)") and ADMIN/ACCOUN/MARKET ("—")
 * have no dedicated OT account in the addendum table, so they're omitted here —
 * OT earning columns simply don't emit a rule for those cost centers.
 */
const OT_WAGE_ACCOUNT: Partial<Record<CostCenter, string>> = {
  LAB: 'COGS - Payroll Expense:COGS - Lab OT Wages',
  RD: 'COGS - Payroll Expense:COGS - R & D OT Wages',
  CS: 'Payroll Expense -:Customer Service - OT Wages',
  DATA: 'Payroll Expense -:Data Entry - OT Wages',
  SHIP: 'Payroll Expense -:Shipping - OT Wages',
};

/** State-UI employer-cost ADP column is state-specific; verified present in live vocab for all 3 states. */
const STATE_UI_COLUMN: Record<Entity, string> = {
  'MedRock FL': 'FL STATE - UNEMPLOYMENT INSURANCE ER',
  'MedRock TN': 'TN STATE - UNEMPLOYMENT INSURANCE ER',
  'MedRock TX': 'TX STATE - UNEMPLOYMENT INSURANCE ER',
};

/**
 * Workers'-comp ADP column is LLC-name-suffixed in the live export ("WORKERS COMPENSATION
 * INSURANCE - MEDROCK PHARMACY LLC - POST-TAX" / "... MEDROCK TN LLC - POST-TAX" — ADP mislabels
 * the category "POST-TAX" but these are the employer WC premium columns). No "MEDROCK TX LLC"
 * variant exists anywhere in the live column vocabulary.
 * TODO(verify-TX-workers-comp-column): confirmed no distinct TX-named WC column in live ADP data;
 * using the FL (parent LLC) column as a placeholder for MedRock TX pending Amy's confirmation of
 * which policy/column actually carries TX employees' WC cost.
 */
const WC_COLUMN: Record<Entity, string> = {
  'MedRock FL': 'WORKERS COMPENSATION INSURANCE - MEDROCK PHARMACY LLC - POST-TAX',
  'MedRock TN': 'WORKERS COMPENSATION INSURANCE - MEDROCK TN LLC - POST-TAX',
  'MedRock TX': 'WORKERS COMPENSATION INSURANCE - MEDROCK PHARMACY LLC - POST-TAX',
};

/**
 * Employee-withholding + NET PAY columns -> single Credit rule each, cost_center '*'.
 * The addendum's generic `<ST> STATE - EE INCOME TAX` template is intentionally omitted:
 * FL, TN, and TX levy no state income tax, so no such ADP column exists for these entities
 * (verified — absent from the live source.payroll_history sensitive-key vocabulary).
 * NOTE: 'RI STATE - DISABILITY INSURANCE  EE' has a double space before "EE" in the live
 * ADP export (an ADP quirk) — reproduced exactly here so column matching works.
 */
const EE_WITHHOLDING_RULES: ReadonlyArray<{ column: string; bucket: CreditBucket }> = [
  { column: 'FEDERAL - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'SOCIAL SECURITY - EE', bucket: 'Taxes' },
  { column: 'MEDICARE - EE', bucket: 'Taxes' },
  { column: 'MEDICARE - ADDITIONAL EE', bucket: 'Taxes' },
  { column: 'MD COUNTY : BALTIMORE - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'RI STATE - DISABILITY INSURANCE  EE', bucket: 'Taxes' },
  { column: 'MEDICAL - EE PRE-TAX', bucket: 'Health' },
  { column: 'DENTAL - EE PRE-TAX', bucket: 'Health' },
  { column: 'VISION - EE PRE-TAX', bucket: 'Health' },
  { column: 'RS 401K - ROTH EE', bucket: 'Retirement' },
  { column: 'RS 401K - TRADITIONAL EE', bucket: 'Retirement' },
  { column: 'GARNISH', bucket: 'Garnishments' },
  { column: 'CHILD PAYMENTS', bucket: 'Garnishments' },
  { column: 'BKWITHHOLD', bucket: 'Garnishments' },
  { column: 'NET PAY', bucket: 'Net Pay' },
];

/** One Debit rule per cost_center (COGS or non-COGS account) + one Credit rule (cost_center '*'). */
function addEmployerCostRules(
  rules: AccountMapRule[],
  entity: Entity,
  columns: readonly string[],
  cogsAccount: string,
  nonCogsAccount: string,
  bucket: CreditBucket,
): void {
  for (const column of columns) {
    for (const cc of COST_CENTERS) {
      const isCogs = COGS_COST_CENTERS.has(cc);
      rules.push({
        entity,
        adpColumn: column,
        costCenter: cc,
        accountName: isCogs ? cogsAccount : nonCogsAccount,
        postingType: 'Debit',
        isCogs,
        creditBucket: null,
        active: true,
      });
    }
    rules.push({
      entity,
      adpColumn: column,
      costCenter: '*',
      accountName: 'Payroll Withholdings',
      postingType: 'Credit',
      isCogs: false,
      creditBucket: bucket,
      active: true,
    });
  }
}

export function buildSeedAccountMap(entity: Entity): AccountMapRule[] {
  const rules: AccountMapRule[] = [];

  // --- Wage earnings: Debit, per cost_center ---
  for (const cc of COST_CENTERS) {
    const isCogs = COGS_COST_CENTERS.has(cc);
    const regularAccount = REGULAR_WAGE_ACCOUNT[cc];
    for (const column of REGULAR_EARNING_COLUMNS) {
      rules.push({
        entity,
        adpColumn: column,
        costCenter: cc,
        accountName: regularAccount,
        postingType: 'Debit',
        isCogs,
        creditBucket: null,
        active: true,
      });
    }
    const otAccount = OT_WAGE_ACCOUNT[cc];
    if (otAccount) {
      for (const column of OT_EARNING_COLUMNS) {
        rules.push({
          entity,
          adpColumn: column,
          costCenter: cc,
          accountName: otAccount,
          postingType: 'Debit',
          isCogs,
          creditBucket: null,
          active: true,
        });
      }
    }
  }

  // --- Employer costs: two rules each (Debit expense by cost_center + Credit '*') ---
  addEmployerCostRules(
    rules,
    entity,
    ['SOCIAL SECURITY - ER', 'MEDICARE - ER', 'FEDERAL UNEMPLOYMENT INSURANCE - ER', STATE_UI_COLUMN[entity]],
    'COGS - Employer Payroll Taxes',
    'Payroll Expense -:Employer Taxes',
    'Taxes',
  );
  addEmployerCostRules(
    rules,
    entity,
    ['RS 401K - BASE MATCH ER'],
    'COGS - 401K Employer Match',
    'Payroll Expense -:401K Employer Match',
    'Retirement',
  );
  addEmployerCostRules(
    rules,
    entity,
    [WC_COLUMN[entity]],
    "COGS - Workmen's Compensation Ins",
    "Payroll Expense -:Workmen's Compensation Ins.",
    'WC',
  );

  // MEDICAL - ER is special-cased in the addendum: a single fixed Debit account
  // (Accrued Payroll Liability) regardless of cost_center, not a COGS/non-COGS split.
  rules.push({
    entity,
    adpColumn: 'MEDICAL - ER',
    costCenter: '*',
    accountName: 'Accrued Payroll Liability',
    postingType: 'Debit',
    isCogs: false,
    creditBucket: null,
    active: true,
  });
  rules.push({
    entity,
    adpColumn: 'MEDICAL - ER',
    costCenter: '*',
    accountName: 'Payroll Withholdings',
    postingType: 'Credit',
    isCogs: false,
    creditBucket: 'Health',
    active: true,
  });

  // --- Employee withholdings + NET PAY: one Credit rule each, cost_center '*' ---
  for (const { column, bucket } of EE_WITHHOLDING_RULES) {
    rules.push({
      entity,
      adpColumn: column,
      costCenter: '*',
      accountName: 'Payroll Withholdings',
      postingType: 'Credit',
      isCogs: false,
      creditBucket: bucket,
      active: true,
    });
  }

  return rules;
}
