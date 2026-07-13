import { FixturePayrollSource, RdsPayrollSource, type PayrollSource } from './source';

export function selectSource(): PayrollSource {
  const key = process.env.PAYROLL_ENC_KEY;
  return key ? new RdsPayrollSource(key) : new FixturePayrollSource();
}
