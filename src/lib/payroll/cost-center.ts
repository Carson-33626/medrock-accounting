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
