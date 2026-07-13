import type { AccountMapRule, EmployeeMapRule, PayrollRow, ResolvedTarget } from './types';
import { costCenterFor } from './cost-center';

export type Resolution = { targets: ResolvedTarget[] } | { unmapped: 'column' };

export function resolveLine(
  row: PayrollRow, adpColumn: string, accountMap: AccountMapRule[], employeeMap: EmployeeMapRule[],
): Resolution {
  const cc = costCenterFor(row.home_department);
  const rules = accountMap.filter((a) => a.adpColumn === adpColumn && (a.costCenter === cc || a.costCenter === '*'));
  if (rules.length === 0) return { unmapped: 'column' };

  const emp = employeeMap.find((e) => e.positionId === row.position_id);
  const targets: ResolvedTarget[] = rules.map((rule) => ({
    accountName: rule.accountName,
    departmentName: emp?.departmentName ?? null,
    className: emp?.className ?? null,
    postingType: rule.postingType,
    creditBucket: rule.creditBucket,
    isCogs: rule.isCogs,
  }));
  return { targets };
}
