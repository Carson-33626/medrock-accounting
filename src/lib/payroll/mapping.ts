import type { AccountMapRule, EmployeeMapRule, PayrollRow, ResolvedTarget } from './types';
export type Resolution = ResolvedTarget | { unmapped: 'column' | 'position' };

export function resolveLine(
  row: PayrollRow, adpColumn: string, accountMap: AccountMapRule[], employeeMap: EmployeeMapRule[],
): Resolution {
  const acct = accountMap.find((a) => a.adpColumn === adpColumn);
  if (!acct) return { unmapped: 'column' };
  const emp = employeeMap.find((e) => e.positionId === row.position_id);
  if (!emp) return { unmapped: 'position' };
  return {
    accountName: acct.accountName,
    departmentName: emp.departmentName,
    className: emp.className,
    postingType: acct.postingType,
    creditBucket: acct.creditBucket,
  };
}
