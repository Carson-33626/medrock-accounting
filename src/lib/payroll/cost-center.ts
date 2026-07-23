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
