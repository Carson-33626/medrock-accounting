/**
 * Derives the cost_center used to key account-map resolution from ADP's
 * home_department (e.g. 'LAB-Lab' -> 'LAB', 'ACCOUN-Accounting' -> 'ACCOUN').
 * See docs/superpowers/specs/2026-07-10-payroll-mapping-addendum.md (Refinement 1).
 */
export function costCenterFor(homeDepartment: string | null | undefined): string {
  if (!homeDepartment) return 'DFLT';
  const trimmed = homeDepartment.trim();
  if (trimmed === '') return 'DFLT';
  const token = trimmed.split('-')[0]?.trim().toUpperCase() ?? '';
  return token === '' ? 'DFLT' : token;
}

/**
 * The pooled wildcard: a rule with this cost_center applies to every role.
 * `resolveLine` accepts a rule when `rule.cost_center === row's cost center` OR `=== '*'`.
 */
export const POOLED_COST_CENTER = '*';

/**
 * Every cost center an account-map rule may legitimately target. Closed by design: adding a
 * department is already a code change (it needs a DEPT_LABEL entry and wage-account mappings
 * in account-map-seed-data.ts), so a rule naming anything outside this set is a typo, not a
 * new department.
 *
 * 'DFLT' is included because costCenterFor() returns it for a blank/missing home_department —
 * a rule may legitimately be written against it.
 */
export const COST_CENTERS = [
  'LAB', 'PHARM', 'RD', 'ADMIN', 'ACCOUN', 'CS', 'DATA', 'SHIP', 'MARKET', 'DFLT',
] as const;

/** What a cost-center picker should offer: the pooled wildcard first, then each real center. */
export const SELECTABLE_COST_CENTERS: readonly string[] = [POOLED_COST_CENTER, ...COST_CENTERS];

/**
 * Guards the account-map's cost_center against values that can never resolve.
 *
 * This is not cosmetic validation. `resolveLine` matches a rule only on an exact cost-center
 * code or the literal '*', so a malformed value silently produces a rule that NEVER fires: the
 * column it was meant to map keeps re-surfacing as "new column detected" forever, and the
 * accountant sees a save that appears to do nothing. Five such rules reached production before
 * this check existed — '*admin', '*Admin' and '*PHARM' (the default '*' with a department typed
 * onto it) and two carrying the entity name 'MedRock FL' — all written through the Mappings
 * tab's free-text cost-center box. See TODO.md 2026-08-06.
 */
export function isValidCostCenter(value: string): boolean {
  return value === POOLED_COST_CENTER || (COST_CENTERS as readonly string[]).includes(value);
}

/**
 * Human department label per cost center, used to build JE line memos so accounting can read
 * each department's slice of a shared account. Matches Amy's memo vocabulary from PR 2026.03.27
 * ('Accounting', 'Admin', 'CSR', 'DE', 'Shipping', 'Lab', 'Pharmacists', 'R & D', 'Marketing').
 * Single source of truth: account-map-seed-data.ts imports this same map.
 */
export const DEPT_LABEL: Record<string, string> = {
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

/**
 * Department label for a cost center, or null when the cost center is DFLT / unknown — in which
 * case a split line carries no ` - <Dept>` suffix (a single pooled remainder line rather than an
 * ugly 'Taxes - DFLT').
 */
export function deptLabelFor(costCenter: string): string | null {
  return DEPT_LABEL[costCenter] ?? null;
}
