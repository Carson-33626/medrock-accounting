import { describe, it, expect } from 'vitest';
import { resolveLine } from './mapping';
import type { AccountMapRule, EmployeeMapRule, PayrollRow } from './types';

const row = { position_id: '1001', home_department: 'LAB-Lab' } as unknown as PayrollRow;

describe('resolveLine', () => {
  it('resolves a wage column with a cost-center-specific rule to one target carrying the Allocate overlay', () => {
    const adminRow = { position_id: '1001', home_department: 'ADMIN-Administration' } as unknown as PayrollRow;
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'ADMIN', accountName: 'Payroll Expense -:Administrative Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '1001', departmentName: null, className: 'Allocate - %', cogsOverride: null, active: true },
    ];
    const res = resolveLine(adminRow, 'REGULAR PAY - EARNING', accountMap, empMap);
    expect('targets' in res).toBe(true);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]).toMatchObject({
      accountName: 'Payroll Expense -:Administrative Wages',
      className: 'Allocate - %',
      postingType: 'Debit',
    });
  });

  it('flags an unknown column as unmapped', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = [];
    expect(resolveLine(row, 'MYSTERY COLUMN', accountMap, empMap)).toEqual({ unmapped: 'column' });
  });

  it('resolves a column with both a cost-center-specific debit rule and a * credit rule into TWO targets (employer double-entry)', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'SOCIAL SECURITY - ER', costCenter: 'LAB', accountName: 'COGS - Employer Payroll Taxes', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
      { entity: 'MedRock FL', adpColumn: 'SOCIAL SECURITY - ER', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Taxes', active: true },
    ];
    const empMap: EmployeeMapRule[] = [];
    const res = resolveLine(row, 'SOCIAL SECURITY - ER', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(2);
    const debit = res.targets.find((t) => t.postingType === 'Debit');
    const credit = res.targets.find((t) => t.postingType === 'Credit');
    expect(debit).toMatchObject({ accountName: 'COGS - Employer Payroll Taxes' });
    expect(credit).toMatchObject({ accountName: 'Payroll Withholdings', creditBucket: 'Taxes' });
    expect(debit?.pooled).toBe(false);
    expect(credit?.pooled).toBe(true);
  });

  it('resolves a column with a cost-center-specific Debit rule AND a * Debit rule to ONE target (cc-specific wins, same-direction duplicate cannot double-book)', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'COGS - Payroll Expense:COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: '*', accountName: 'Payroll Expense:Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = [];
    const res = resolveLine(row, 'REGULAR PAY - EARNING', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]).toMatchObject({ accountName: 'COGS - Payroll Expense:COGS - Lab Wages', postingType: 'Debit' });
  });

  it('still resolves a row whose position has no employee rule, with null department/class (NOT unmapped)', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = []; // no overlay for position 1001
    const res = resolveLine(row, 'REGULAR PAY - EARNING', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]).toMatchObject({ accountName: 'COGS - Lab Wages', departmentName: null, className: null });
  });
});

describe('resolveLine cost-center attribution', () => {
  const ccRow = { position_id: '1001', home_department: 'PHARM-Pharmacy' } as unknown as PayrollRow;

  it('sets costCenter to the row cost center and pooled=false for a cost-center-specific rule', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'PHARM', accountName: 'COGS - Pharmacists Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true, memo: 'Pharmacists Wages' },
    ];
    const res = resolveLine(ccRow, 'REGULAR PAY - EARNING', accountMap, []);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets[0].costCenter).toBe('PHARM');
    expect(res.targets[0].pooled).toBe(false);
  });

  it('sets pooled=true when the matched rule is a * rule', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'NET PAY', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Net Pay', active: true },
    ];
    const res = resolveLine(ccRow, 'NET PAY', accountMap, []);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets[0].costCenter).toBe('PHARM');
    expect(res.targets[0].pooled).toBe(true);
  });
});

describe('resolveLine Allocate - % department override', () => {
  const allocateRow = { position_id: '2001', home_department: 'ADMIN-Administration' } as unknown as PayrollRow;
  // A location-owned cost center, for the cases that assert the overlay is NOT applied.
  const labRow = { position_id: '2001', home_department: 'LAB-Lab' } as unknown as PayrollRow;

  it('overrides employee mapped department to % Allocation for a shared cost center', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'ADMIN', accountName: 'Payroll Expense -:Administrative Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '2001', departmentName: 'Miami Region', className: 'Allocate - %', cogsOverride: null, active: true },
    ];
    const res = resolveLine(allocateRow, 'REGULAR PAY - EARNING', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]).toMatchObject({
      accountName: 'Payroll Expense -:Administrative Wages',
      departmentName: '% Allocation',
      className: 'Allocate - %',
    });
  });

  it('keeps mapped department for a directed allocate class', () => {
    const marketRow = { position_id: '2001', home_department: 'MARKET-Marketing' } as unknown as PayrollRow;
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'MARKET', accountName: 'Payroll Expense -:Marketing Wages - Base', postingType: 'Debit', isCogs: false, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '2001', departmentName: 'TX Region', className: 'Allocate - TX', cogsOverride: null, active: true },
    ];
    const res = resolveLine(marketRow, 'REGULAR PAY - EARNING', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]).toMatchObject({
      accountName: 'Payroll Expense -:Marketing Wages - Base',
      departmentName: 'TX Region',
      className: 'Allocate - TX',
    });
  });

  it('carries the Allocate - % overlay on Debit targets ONLY — credit lines must stay out of the EOM pool', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'SOCIAL SECURITY - ER', costCenter: 'ADMIN', accountName: 'Payroll Expense -:Employer Taxes', postingType: 'Debit', isCogs: false, creditBucket: null, active: true },
      { entity: 'MedRock FL', adpColumn: 'SOCIAL SECURITY - ER', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Taxes', active: true },
    ];
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '2001', departmentName: null, className: 'Allocate - %', cogsOverride: null, active: true },
    ];
    const res = resolveLine(allocateRow, 'SOCIAL SECURITY - ER', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    const debit = res.targets.find((t) => t.postingType === 'Debit');
    const credit = res.targets.find((t) => t.postingType === 'Credit');
    expect(debit).toMatchObject({ departmentName: '% Allocation', className: 'Allocate - %' });
    expect(credit).toMatchObject({ departmentName: null, className: null });
  });

  it('strips the overlay from Credit targets for every Allocate-family class (Allocate - TX net pay must not hit the attention list)', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'NET PAY', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Net Pay', active: true },
    ];
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '2001', departmentName: 'Dallas Region', className: 'Allocate - TX', cogsOverride: null, active: true },
    ];
    const res = resolveLine(allocateRow, 'NET PAY', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]).toMatchObject({ postingType: 'Credit', departmentName: null, className: null });
  });

  it('strips the % Allocation DEPARTMENT from Credit targets too (marketers mapped by dept, no class)', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'MARKET', accountName: 'Payroll Expense:Marketing Wages - Base', postingType: 'Debit', isCogs: false, creditBucket: null, active: true },
      { entity: 'MedRock FL', adpColumn: 'NET PAY', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Net Pay', active: true },
    ];
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '2001', departmentName: '% Allocation', className: null, cogsOverride: null, active: true },
    ];
    const marketRow = { position_id: '2001', home_department: 'MARKET-Marketing' } as unknown as PayrollRow;
    const wages = resolveLine(marketRow, 'REGULAR PAY - EARNING', accountMap, empMap);
    const net = resolveLine(marketRow, 'NET PAY', accountMap, empMap);
    if (!('targets' in wages) || !('targets' in net)) throw new Error('expected targets');
    expect(wages.targets[0]).toMatchObject({ postingType: 'Debit', departmentName: '% Allocation' });
    expect(net.targets[0]).toMatchObject({ postingType: 'Credit', departmentName: null, className: null });
  });

  it('keeps the overlay on Credit targets for a NON-Allocate class (regional tagging unchanged)', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'NET PAY', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Net Pay', active: true },
    ];
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '2001', departmentName: 'Dallas Region', className: null, cogsOverride: null, active: true },
    ];
    const res = resolveLine(labRow, 'NET PAY', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets[0]).toMatchObject({ postingType: 'Credit', departmentName: 'Dallas Region', className: null });
  });

  it('keeps mapped department when no class is set', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '2001', departmentName: 'Dallas Region', className: null, cogsOverride: null, active: true },
    ];
    const res = resolveLine(labRow, 'REGULAR PAY - EARNING', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]).toMatchObject({
      accountName: 'COGS - Lab Wages',
      departmentName: 'Dallas Region',
      className: null,
    });
  });
});

/**
 * The rule that decides WHETHER a line joins the month-end pool, and on which basis.
 * Derived from the cost center of the pay period being built — see mapping.allocateClassFor.
 */
describe('resolveLine allocation flag derives from the cost center', () => {
  const wageRule = (costCenter: string, accountName: string): AccountMapRule => ({
    entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter, accountName,
    postingType: 'Debit', isCogs: false, creditBucket: null, active: true,
  });
  const rowIn = (dept: string): PayrollRow =>
    ({ position_id: '3001', home_department: dept }) as unknown as PayrollRow;

  it.each([
    ['CS-Customer Service', 'CS', 'Payroll Expense -:Customer Service Wages'],
    ['ADMIN-Administration', 'ADMIN', 'Payroll Expense -:Administrative Wages'],
    ['ACCOUN-Accounting', 'ACCOUN', 'Payroll Expense -:Administrative Wages'],
  ])('%s pools on the revenue rule with NO employee-map row at all', (dept, cc, account) => {
    const res = resolveLine(rowIn(dept), 'REGULAR PAY - EARNING', [wageRule(cc, account)], []);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets[0]).toMatchObject({ className: 'Allocate - %', departmentName: '% Allocation' });
  });

  it.each([
    ['SHIP-Shipping', 'SHIP'],
    ['LAB-Lab', 'LAB'],
    ['PHARM-Pharmacy', 'PHARM'],
    ['RD-Research', 'RD'],
    ['DATA-Data Entry', 'DATA'],
  ])('%s is location-owned and never pools, even when the roster still tags it', (dept, cc) => {
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '3001', departmentName: null, className: 'Allocate - %', cogsOverride: null, active: true },
    ];
    const res = resolveLine(rowIn(dept), 'REGULAR PAY - EARNING', [wageRule(cc, 'Payroll Expense -:Wages')], empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets[0]).toMatchObject({ className: null, departmentName: null });
  });

  it('regression — a promoted employee still tagged Allocate - % does not drag their SHIPPING months into the pool', () => {
    // Alexander Graulau-Lugo (000155): Shipping Jan-May 2026, purchasing admin from June.
    // The Aug seeding tagged him as an admin; the next rebuild applied that tag backward and
    // split $23,778.64 of shipping labor three ways, ~$15,852 of it off FL.
    const stillTagged: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '3001', departmentName: null, className: 'Allocate - %', cogsOverride: null, active: true },
    ];
    const shippingMonth = resolveLine(
      rowIn('SHIP-Shipping'), 'REGULAR PAY - EARNING', [wageRule('SHIP', 'Payroll Expense -:Shipping Wages')], stillTagged,
    );
    if (!('targets' in shippingMonth)) throw new Error('expected targets');
    expect(shippingMonth.targets[0].className).toBeNull();

    // ...while the months he really was an admin still pool, from the very same roster row.
    const adminMonth = resolveLine(
      rowIn('ADMIN-Administration'), 'REGULAR PAY - EARNING', [wageRule('ADMIN', 'Payroll Expense -:Administrative Wages')], stillTagged,
    );
    if (!('targets' in adminMonth)) throw new Error('expected targets');
    expect(adminMonth.targets[0].className).toBe('Allocate - %');
  });

  it('a directed class outranks the cost center — marketing passthrough survives', () => {
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '3001', departmentName: 'TX Region', className: 'Allocate - TX', cogsOverride: null, active: true },
    ];
    const res = resolveLine(rowIn('MARKET-Marketing'), 'REGULAR PAY - EARNING', [wageRule('MARKET', 'Payroll Expense -:Marketing Wages - Base')], empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets[0]).toMatchObject({ className: 'Allocate - TX', departmentName: 'TX Region' });
  });

  it('a 50/50 directed class survives on a shared cost center too', () => {
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '3001', departmentName: 'Split', className: 'Allocate - Split TN50', cogsOverride: null, active: true },
    ];
    const res = resolveLine(rowIn('ADMIN-Administration'), 'REGULAR PAY - EARNING', [wageRule('ADMIN', 'Payroll Expense -:Administrative Wages')], empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets[0].className).toBe('Allocate - Split TN50');
  });

  it('a bare % Allocation department with no class is left alone (marketers, pending Ash)', () => {
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '3001', departmentName: '% Allocation', className: null, cogsOverride: null, active: true },
    ];
    const res = resolveLine(rowIn('MARKET-Marketing'), 'REGULAR PAY - EARNING', [wageRule('MARKET', 'Payroll Expense -:Marketing Wages - Base')], empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets[0]).toMatchObject({ className: null, departmentName: '% Allocation' });
  });
});
