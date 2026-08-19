import type { AccountMapRule, EmployeeMapRule, PayrollRow, PostingType, ResolvedTarget } from './types';
import { costCenterFor } from './cost-center';

export type Resolution = { targets: ResolvedTarget[] } | { unmapped: 'column' };

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
  // Amy's pool convention: an Allocate - % class always pairs with the '% Allocation'
  // department so the month-end allocation pool picks the line up (spec §4.7). The
  // cost-center label stays in the memo — dollars and memos are unchanged.
  const dept = emp?.className === 'Allocate - %' ? '% Allocation' : emp?.departmentName ?? null;
  // An Allocate flag marks a COST to redistribute, so it rides expense debits only. Amy
  // never tagged the credit side (net pay, withholdings) — and qb-pool reads credits as
  // negatives, so a tagged credit would net the employee's wages out of the EOM pool.
  // Both spellings of the flag gate this: an Allocate* class AND a bare '% Allocation'
  // department (marketers are mapped that way, with no class).
  const isAllocate = emp?.className?.startsWith('Allocate') === true || dept === '% Allocation';
  const targets: ResolvedTarget[] = chosen.map((rule) => {
    const carryOverlay = !isAllocate || rule.postingType === 'Debit';
    return {
      accountName: rule.accountName,
      departmentName: carryOverlay ? dept : null,
      className: carryOverlay ? emp?.className ?? null : null,
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
