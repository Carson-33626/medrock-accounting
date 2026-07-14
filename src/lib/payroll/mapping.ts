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
  const targets: ResolvedTarget[] = chosen.map((rule) => ({
    accountName: rule.accountName,
    departmentName: emp?.departmentName ?? null,
    className: emp?.className ?? null,
    postingType: rule.postingType,
    creditBucket: rule.creditBucket,
    isCogs: rule.isCogs,
    memo: rule.memo ?? null,
  }));
  return { targets };
}
