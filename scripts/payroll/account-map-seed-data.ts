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

/**
 * Department label per cost_center, used to build the JE line MEMO so accounting can read each
 * department's slice of a shared account (Barbara's ask: memo notes by department, NOT new
 * accounts). Matches Amy's FL memo vocabulary from PR 2026.03.27 ("Accounting Wages", "Admin
 * Wages", "CSR Wages", "DE Wages", "Shipping Wages", "Lab Wages", "Pharmacists Wages") and applies
 * it CONSISTENTLY across all 3 entities (Amy's TN JE lazily memo'd everything "Regular Wages" —
 * the exact thing this fixes). Splitting is memo-driven: same account, distinct memo -> distinct
 * line, identical account totals (so the dry-run still reconciles to Amy penny-for-penny).
 */
const DEPT_LABEL: Record<CostCenter, string> = {
  LAB: 'Lab',
  PHARM: 'Pharmacists',
  RD: 'R & D',
  ADMIN: 'Admin',
  ACCOUN: 'Accounting',
  CS: 'CSR',
  DATA: 'DE',
  SHIP: 'Shipping',
  MARKET: 'Marketing',
};

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
 * Out-of-state employer-cost columns for remote marketing reps living outside their
 * employing entity's home state (confirmed real $ in TN's 03/27/2026 unmapped-column
 * dollar sums — e.g. `CO STATE - UNEMPLOYMENT INSURANCE ER` $91.70). Only MARKET-cost-center
 * rows carry nonzero values for these, so folding them into the same employer-taxes group as
 * SOCIAL SECURITY - ER / MEDICARE - ER / FEDERAL/STATE UI - ER is safe (mapping.ts resolves by
 * the row's own home_department cost_center, so non-MARKET rows for these columns are simply
 * absent/zero and never reach the resolver).
 */
const OUT_OF_STATE_UI_ER_COLUMNS = [
  'CO STATE - UNEMPLOYMENT INSURANCE ER',
  'NC STATE - UNEMPLOYMENT INSURANCE ER',
  'RI STATE - UNEMPLOYMENT INSURANCE ER',
  'IL STATE - UNEMPLOYMENT INSURANCE ER',
  'MD STATE - UNEMPLOYMENT INSURANCE ER',
  'OH STATE - UNEMPLOYMENT INSURANCE ER',
  // Double space before "ER" is a real ADP quirk (verified in the live 03/27/2026 TN data),
  // matching the same pattern as 'RI STATE - DISABILITY INSURANCE  EE' below.
  'CO STATE - FAMILY AND MEDICAL LEAVE INSURANCE  ER',
] as const;

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
 * Garnishment/wage-order credit account is ENTITY-SPECIFIC in Amy's real COA — confirmed by
 * pulling the distinct AccountRef.name set + full line detail from her PR 2026.03.27 JE
 * (scripts/payroll/probe-full-je-accounts.ts, read-only): FL books the actual $ to
 * 'Employee Garnishment Liability' (Credit 289.21 "Child Support"), while TN books the same
 * kind of $ to the generic 'Payroll Withholdings' pool (Credit 1,269.89 "Wage Garnishments")
 * and its 'Employee Garnishment Liability' line is an unused $0.00 placeholder. TX has no
 * matching JE to verify against — defaulted to TN's behavior (the more common ADP-pooled
 * pattern) pending confirmation.
 * TODO(verify-TX-garnishment-account): no TX JE exists for 03/27/2026 to confirm which
 * account TX's garnishment deductions actually post to; using 'Payroll Withholdings' (TN's
 * pattern) as the default.
 */
const GARNISHMENT_ACCOUNT: Record<Entity, string> = {
  'MedRock FL': 'Employee Garnishment Liability',
  'MedRock TN': 'Payroll Withholdings',
  'MedRock TX': 'Payroll Withholdings',
};

/**
 * Employee-withholding + NET PAY columns -> single Credit rule each, cost_center '*'.
 * The addendum's generic `<ST> STATE - EE INCOME TAX` template is intentionally omitted for
 * FL/TN/TX HOME-state income tax (none of the 3 levy one), but MedRock's marketing reps live
 * and work out of dozens of OTHER states, and ADP withholds THEIR state income tax on the TN
 * (and, per this same real-dollar pattern, FL/TX) payroll — confirmed real $ in the 03/27/2026
 * unmapped-column dollar sums (e.g. `GA STATE - EE INCOME TAX` $1,031.40 for TN) and Amy's real
 * COA has exactly ONE pooled EE-withholding account ('Payroll Withholdings') for every EE tax
 * type regardless of state, so mapping these to it is not a guess.
 * NOTE: 'RI STATE - DISABILITY INSURANCE  EE' and 'CO STATE - FAMILY AND MEDICAL LEAVE
 * INSURANCE  EE' both have a double space before "EE" in the live ADP export (an ADP quirk)
 * — reproduced exactly here so column matching works.
 */
const EE_WITHHOLDING_RULES: ReadonlyArray<{ column: string; bucket: CreditBucket }> = [
  { column: 'FEDERAL - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'SOCIAL SECURITY - EE', bucket: 'Taxes' },
  { column: 'MEDICARE - EE', bucket: 'Taxes' },
  { column: 'MEDICARE - ADDITIONAL EE', bucket: 'Taxes' },
  { column: 'MD COUNTY : BALTIMORE - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'RI STATE - DISABILITY INSURANCE  EE', bucket: 'Taxes' },
  // Out-of-state EE income tax for remote marketing reps (real $ confirmed in TN 03/27/2026 data).
  { column: 'GA STATE - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'IL STATE - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'RI STATE - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'NC STATE - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'CO STATE - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'OH STATE - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'MD STATE - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'AZ STATE - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'OH MUNICIPAL : GRANDVIEW HEIGHTS - EE INCOME TAX', bucket: 'Taxes' },
  { column: 'CO STATE - FAMILY AND MEDICAL LEAVE INSURANCE  EE', bucket: 'Taxes' },
  { column: 'MEDICAL - EE PRE-TAX', bucket: 'Health' },
  { column: 'DENTAL - EE PRE-TAX', bucket: 'Health' },
  { column: 'VISION - EE PRE-TAX', bucket: 'Health' },
  { column: 'RS 401K - ROTH EE', bucket: 'Retirement' },
  { column: 'RS 401K - TRADITIONAL EE', bucket: 'Retirement' },
  // TN's alternate 401(k) plan (401086) — mirrors the base-plan rules above exactly.
  { column: 'RS 401K 088086 - ROTH EE', bucket: 'Retirement' },
  { column: 'RS 401K 088086 - TRADITIONAL EE', bucket: 'Retirement' },
  // 401(k) loan repayments post back into the same Retirement liability pool — no distinct
  // loan account was found in Amy's real COA (see probe-full-je-accounts.ts dump). Double
  // space before "401A" is a real ADP quirk, reproduced exactly.
  { column: 'RS 401K LOAN -  401A POST-TAX', bucket: 'Retirement' },
  { column: 'RS 401K LOAN 2 -  401A POST-TAX', bucket: 'Retirement' },
  { column: 'RS 401K LOAN2 088086 -  401A POST-TAX', bucket: 'Retirement' },
  { column: 'GARNISH', bucket: 'Garnishments' },
  { column: 'CHILD PAYMENTS', bucket: 'Garnishments' },
  { column: 'BKWITHHOLD', bucket: 'Garnishments' },
  { column: 'NET PAY', bucket: 'Net Pay' },
];

/**
 * One Debit rule per cost_center (COGS or non-COGS account) + one Credit rule (cost_center '*').
 * `memoKind` is the department-agnostic prefix of the Debit line memo ("ER Taxes", "401K", "WC");
 * each Debit rule's memo becomes "<memoKind> - <Dept>" so an otherwise-shared employer-cost account
 * (e.g. 'Payroll Expense -:Employer Taxes', which every non-COGS cost_center hits) splits into one
 * readable line per department. The '*' Credit rule stays memo-less (uses its creditBucket).
 */
function addEmployerCostRules(
  rules: AccountMapRule[],
  entity: Entity,
  columns: readonly string[],
  cogsAccount: string,
  nonCogsAccount: string,
  bucket: CreditBucket,
  memoKind: string,
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
        memo: `${memoKind} - ${DEPT_LABEL[cc]}`,
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

/**
 * Split a pooled '*' debit special (a single fixed account, no COGS/non-COGS split) into one
 * memo-labelled line per department, PLUS a memo-less '*' fallback. resolveLine picks the
 * cost-center rule over '*' within a direction, so a known-department row gets its `<memoKind> -
 * <Dept>` line and only a blank/unknown-department row falls back to the pooled '*' line — no
 * double-count, and no column becomes newly unmapped. This is Barbara's "the memo line should
 * reflect the department" ask (2026-07-21) applied to the previously memo-less pooled lines
 * (MEDICAL - ER / CAR ALLOWANCE / REIMBURSEMENT / BONUS), same idea as addEmployerCostRules.
 */
function addPerDeptDebitSpecial(
  rules: AccountMapRule[], entity: Entity, column: string, accountName: string, memoKind: string,
): void {
  for (const cc of COST_CENTERS) {
    rules.push({
      entity, adpColumn: column, costCenter: cc, accountName, postingType: 'Debit',
      isCogs: false, creditBucket: null, active: true, memo: `${memoKind} - ${DEPT_LABEL[cc]}`,
    });
  }
  rules.push({
    entity, adpColumn: column, costCenter: '*', accountName, postingType: 'Debit',
    isCogs: false, creditBucket: null, active: true,
  });
}

export function buildSeedAccountMap(entity: Entity): AccountMapRule[] {
  const rules: AccountMapRule[] = [];

  // --- Wage earnings: Debit, per cost_center ---
  // All regular-earning columns for a cost_center share one memo ("<Dept> Wages") so they collapse
  // into a single per-department wage line (matching Amy's one "Admin Wages" / "Accounting Wages"
  // line that aggregates every earning type); OT columns get "<Dept> Wages - OT".
  for (const cc of COST_CENTERS) {
    const isCogs = COGS_COST_CENTERS.has(cc);
    const dept = DEPT_LABEL[cc];
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
        memo: `${dept} Wages`,
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
          memo: `${dept} Wages - OT`,
        });
      }
    }
  }

  // --- Employer costs: two rules each (Debit expense by cost_center + Credit '*') ---
  // COGS-side account names below carry the 'COGS - Payroll Expense:' parent prefix to match
  // Amy's real COA exactly (confirmed via probe-full-je-accounts.ts against her 03/27/2026 JE —
  // the addendum's flat names omitted this prefix, a real transcription gap this dry-run caught).
  addEmployerCostRules(
    rules,
    entity,
    [
      'SOCIAL SECURITY - ER',
      'MEDICARE - ER',
      'FEDERAL UNEMPLOYMENT INSURANCE - ER',
      STATE_UI_COLUMN[entity],
      ...OUT_OF_STATE_UI_ER_COLUMNS,
    ],
    'COGS - Payroll Expense:COGS - Employer Payroll Taxes',
    'Payroll Expense -:Employer Taxes',
    'Taxes',
    'ER Taxes',
  );
  addEmployerCostRules(
    rules,
    entity,
    ['RS 401K - BASE MATCH ER', 'RS 401K 088086 - BASE MATCH ER'],
    'COGS - Payroll Expense:COGS - 401K Employer Match',
    'Payroll Expense -:401K Employer Match',
    'Retirement',
    '401K',
  );
  addEmployerCostRules(
    rules,
    entity,
    [WC_COLUMN[entity]],
    "COGS - Payroll Expense:COGS - Workmen's Compensation Ins",
    "Payroll Expense -:Workmen's Compensation Ins.",
    'WC',
    'WC',
  );

  // MEDICAL - ER is special-cased in the addendum: a single fixed Debit account
  // (Accrued Payroll Liability) regardless of cost_center, not a COGS/non-COGS split. Split per
  // department by memo (Barbara 2026-07-21) — the credit stays one pooled '*' Health line below.
  addPerDeptDebitSpecial(rules, entity, 'MEDICAL - ER', 'Accrued Payroll Liability', 'ER Medical');
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
  // Garnishments-bucket columns use the entity-specific GARNISHMENT_ACCOUNT (see comment above
  // its definition) instead of the generic 'Payroll Withholdings' pool used by every other bucket.
  for (const { column, bucket } of EE_WITHHOLDING_RULES) {
    rules.push({
      entity,
      adpColumn: column,
      costCenter: '*',
      accountName: bucket === 'Garnishments' ? GARNISHMENT_ACCOUNT[entity] : 'Payroll Withholdings',
      postingType: 'Credit',
      isCogs: false,
      creditBucket: bucket,
      active: true,
    });
  }

  // Company-loan repayment (Barbara, 2026-07-20): a post-tax deduction that repays an employee
  // advance, so it does NOT belong in the 'Payroll Withholdings' liability pool like every other
  // EE withholding — it retires an asset. Credits QBO 1215 'Employee Advances' (Other Current
  // Asset; verified present under that exact name in all three companies via
  // probe-account-1215.ts), reducing the receivable as the employee pays it down.
  // This column was previously unmapped, which dropped its credit line while NET PAY already
  // reflected the deduction — the direct cause of the FL ~$250 / TN $1,391.35 residuals.
  rules.push({
    entity,
    adpColumn: 'COMPANY LOAN - EE - PRINCIPAL POST-TAX',
    costCenter: '*',
    accountName: 'Employee Advances',
    postingType: 'Credit',
    isCogs: false,
    creditBucket: 'Other',
    active: true,
  });

  // --- Real-dollar "specials" confirmed against Amy's actual 03/27/2026 JE (Debit-only, like
  // wage-earning columns — their Credit-side offset is already captured by the generic NET PAY
  // credit rule above, since these amounts flow through to the employee's take-home pay). Fixed
  // single account regardless of cost_center; now split per department by memo (Barbara
  // 2026-07-21), same as MEDICAL - ER above, with a '*' fallback for blank-department rows. ---
  const SPECIAL_DEBIT_COLUMNS: ReadonlyArray<{ column: string; accountName: string; memoKind: string }> = [
    { column: 'CAR ALLOWANCE - EARNING', accountName: 'Accrued Payroll Liability', memoKind: 'Car Allowance' },
    {
      column: 'REIMBURSEMENT - REIMBURSEMENT NON-TAXABLE NON TAXABLE REIMBURSEMENT',
      accountName: 'Payroll Reimbursement Liabilities',
      memoKind: 'Reimbursement',
    },
    // NOTE: confirmed in Amy's FL JE ("Bonus - Marketing" -> Payroll Expense -:Bonus Wages,
    // single non-COGS account, not per-cost-center) and matches TX's real 'BONUS - EARNING'
    // dollars. FL's own 03/27/2026 payroll_history rows have NO 'BONUS - EARNING' column value
    // at all despite Amy's JE showing a $374.00 Bonus Wages line that date — that specific
    // dollar amount is NOT sourced from this ADP column/date's row set (likely a separate
    // off-cycle bonus run not captured by this fetch) and remains an unresolved residual;
    // this rule is still correct/needed for TX and any future FL data with real BONUS $.
    { column: 'BONUS - EARNING', accountName: 'Payroll Expense -:Bonus Wages', memoKind: 'Bonus' },
  ];
  for (const { column, accountName, memoKind } of SPECIAL_DEBIT_COLUMNS) {
    addPerDeptDebitSpecial(rules, entity, column, accountName, memoKind);
  }

  return rules;
}
