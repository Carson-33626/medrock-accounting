import type { AccountMapRule, EmployeeMapRule, PayrollRow, PostingType, ResolvedTarget } from './types';
import { costCenterFor } from './cost-center';

export type Resolution = { targets: ResolvedTarget[] } | { unmapped: 'column' };

/**
 * Cost centers whose labor is SHARED across the pharmacies and therefore enters the
 * month-end pool — split into the two rules Ash confirmed 2026-08-25 ("Allocated by
 * revenue for CS, everything else is by 1/3 for those splitters"): Customer Service
 * follows the revenue % rule, Admin and Accounting split a third each.
 *
 * Marketing never pools ("marketing is already going to where they're employed so
 * marketing does not need to be split" — same answer), and everything absent from both
 * sets — SHIP, LAB, PHARM, RD, DATA, MARKET — is location-owned and must never be pooled.
 */
const REVENUE_POOL_COST_CENTERS: readonly string[] = ['CS'];
const THIRDS_POOL_COST_CENTERS: readonly string[] = ['ADMIN', 'ACCOUN'];

/** Directed Allocate classes name a specific counterparty, which no cost center can express:
 *  `Allocate - TX` (100% passthrough) and `Allocate - Split TN50` (50/50). These stay under
 *  the accountant's control on the employee map. The general rules do not. */
const DIRECTED_CLASS_RE = /^Allocate - (?:(?:FL|TN|TX)|Split (?:FL|TN|TX)50)$/;

/**
 * The Allocate class a line carries, derived from the cost center it was worked in.
 *
 * Why the cost center and not the employee-map tag: the tag is a single current-state row
 * per person, while `home_department` is per pay period. Alexander Graulau-Lugo (000155)
 * was Shipping Jan-May 2026 and moved to purchasing admin in June; the August seeding tagged
 * him `Allocate - %` as an admin, and the next full rebuild applied that tag BACKWARD over
 * his shipping months — splitting $23,778.64 of location-owned shipping labor three ways,
 * ~$15,852 of it off FL. Deriving from the cost center in the pay period being built makes
 * that class of error impossible: SHIP is not an allocated cost center, in any month.
 *
 * A directed class on the employee map still wins (see DIRECTED_CLASS_RE) — those encode a
 * routing decision, not a department. Ash confirmed 2026-08-25 the five directed marketers
 * (`Allocate - TX`) keep their routing; the dept-only marketers stay with their employer
 * (handled in resolveLine, which strips the bare '% Allocation' department when no pool
 * class is derived here).
 */
export function allocateClassFor(costCenter: string, mappedClass: string | null): string | null {
  if (mappedClass !== null && DIRECTED_CLASS_RE.test(mappedClass)) return mappedClass;
  if (REVENUE_POOL_COST_CENTERS.includes(costCenter)) return 'Allocate - %';
  if (THIRDS_POOL_COST_CENTERS.includes(costCenter)) return 'Allocate - SplitX3';
  // Not a shared cost center: drop any general Allocate class the roster still carries.
  return mappedClass !== null && mappedClass.startsWith('Allocate') ? null : mappedClass;
}

/** The two classes allocateClassFor derives for pooled cost centers — the spellings the
 *  month-end pool classifies as 'revenue' and 'thirds' respectively. */
export function isPoolClass(className: string | null): boolean {
  return className === 'Allocate - %' || className === 'Allocate - SplitX3';
}

export function resolveLine(
  row: PayrollRow, adpColumn: string, accountMap: AccountMapRule[], employeeMap: EmployeeMapRule[],
): Resolution {
  const cc = costCenterFor(row.home_department);
  const matched = accountMap.filter((a) => a.adpColumn === adpColumn && (a.costCenter === cc || a.costCenter === '*'));
  if (matched.length === 0) return { unmapped: 'column' };

  // Per-direction specificity: a cost-center-specific rule wins over a '*' rule within the
  // SAME posting direction (so a stray same-direction duplicate can't double-book), while a
  // cc-specific Debit plus a '*' Credit still both fire (preserves employer double-entry).
  const pick = (pt: PostingType): AccountMapRule[] => {
    const inDir = matched.filter((m) => m.postingType === pt);
    const specific = inDir.filter((m) => m.costCenter === cc);
    return specific.length > 0 ? specific : inDir.filter((m) => m.costCenter === '*');
  };
  const chosen = [...pick('Debit'), ...pick('Credit')];

  const emp = employeeMap.find((e) => e.positionId === row.position_id);
  const empClass = allocateClassFor(cc, emp?.className ?? null);
  // Amy's pool convention: a pool class (Allocate - % / SplitX3) always pairs with the
  // '% Allocation' department so the month-end allocation pool picks the line up (spec
  // §4.7). The cost-center label stays in the memo — dollars and memos are unchanged.
  // The reverse also holds: a bare '% Allocation' department with NO pool class (how the
  // dept-only marketers are mapped) is stripped — the dept alone would re-admit the line
  // to the pool, and Ash confirmed 2026-08-25 marketing stays with the employing entity.
  const mappedDept = emp?.departmentName ?? null;
  const dept = isPoolClass(empClass) ? '% Allocation'
    : mappedDept === '% Allocation' ? null
    : mappedDept;
  // An Allocate flag marks a COST to redistribute, so it rides expense debits only. Amy
  // never tagged the credit side (net pay, withholdings) — and qb-pool reads credits as
  // negatives, so a tagged credit would net the employee's wages out of the EOM pool.
  // Both spellings of the flag gate this: an Allocate* class AND a bare '% Allocation'
  // department (marketers are mapped that way, with no class).
  const isAllocate = empClass?.startsWith('Allocate') === true || dept === '% Allocation';
  const targets: ResolvedTarget[] = chosen.map((rule) => {
    const carryOverlay = !isAllocate || rule.postingType === 'Debit';
    return {
      accountName: rule.accountName,
      departmentName: carryOverlay ? dept : null,
      className: carryOverlay ? empClass : null,
      postingType: rule.postingType,
      creditBucket: rule.creditBucket,
      isCogs: rule.isCogs,
      memo: rule.memo ?? null,
      costCenter: cc,
      pooled: rule.costCenter === '*',
    };
  });
  return { targets };
}
