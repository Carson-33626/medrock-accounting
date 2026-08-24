import { describe, it, expect } from 'vitest';
import {
  accountsForCategory,
  matchBalanceSheetAccount,
  CATEGORY_ACCOUNT_MAP,
} from './category-accounts';
import { INVENTORY_ACCOUNT, COGS_ACCOUNT } from './monthly-close';

describe('accountsForCategory', () => {
  it('maps each known RDS category to its QB sub-account pair', () => {
    expect(accountsForCategory('Commercial Rx')).toEqual({
      inventory: 'Inventory Asset:Commercial Rx Inventory',
      cogs: 'Cost of Goods Sold:Commercial RX',
      mapped: true,
    });
    expect(accountsForCategory('Compound Ingredient')).toEqual({
      inventory: 'Inventory Asset:Compound Ingredient Inventory',
      cogs: 'Cost of Goods Sold:Compound Ingredient',
      mapped: true,
    });
    expect(accountsForCategory('Lab Compound Packaging Inventory')).toEqual({
      inventory: 'Inventory Asset:Compound Packaging Inventory',
      cogs: 'Cost of Goods Sold:Compound Packaging',
      mapped: true,
    });
    expect(accountsForCategory('Lab Supplies')).toEqual({
      inventory: 'Inventory Asset:Lab Supplies Inventory',
      cogs: 'Cost of Goods Sold:Lab Supplies',
      mapped: true,
    });
  });

  it('falls back to the parent accounts for Uncoded, flagged as unmapped', () => {
    expect(accountsForCategory('Uncoded')).toEqual({
      inventory: INVENTORY_ACCOUNT,
      cogs: COGS_ACCOUNT,
      mapped: false,
    });
  });

  it('falls back to the parent accounts for Opening Balance, flagged as unmapped', () => {
    expect(accountsForCategory('Opening Balance')).toEqual({
      inventory: INVENTORY_ACCOUNT,
      cogs: COGS_ACCOUNT,
      mapped: false,
    });
  });

  it('falls back rather than throwing for a category nobody has seen yet', () => {
    const result = accountsForCategory('Some Future Category');
    expect(result.mapped).toBe(false);
    expect(result.inventory).toBe(INVENTORY_ACCOUNT);
    expect(result.cogs).toBe(COGS_ACCOUNT);
  });

  it('never maps a category to a balance-sheet-style numbered name', () => {
    for (const pair of Object.values(CATEGORY_ACCOUNT_MAP)) {
      expect(pair.inventory).not.toMatch(/^\d/);
      expect(pair.cogs).not.toMatch(/^\d/);
    }
  });
});

describe('matchBalanceSheetAccount', () => {
  // The two QB naming conventions, exactly as captured live on 2026-08-24:
  // Account entity FullyQualifiedName vs BalanceSheet report leaf name.
  const accountNums: Record<string, string> = {
    'Inventory Asset': '1220',
    'Inventory Asset:Commercial Rx Inventory': '1220.05',
    'Inventory Asset:Compound Ingredient Inventory': '1220.10',
    'Inventory Asset:Compound Packaging Inventory': '1220.15',
    'Inventory Asset:Lab Supplies Inventory': '1220.20',
  };
  const bsAccounts = [
    { name: '1220.05 Commercial Rx Inventory', value: 102685.29 },
    { name: '1220.10 Compound Ingredient Inventory', value: 630754.05 },
    { name: '1220.15 Compound Packaging Inventory', value: 155808.92 },
    { name: '1220.20 Lab Supplies Inventory', value: 4986.07 },
  ];

  it('bridges a FullyQualifiedName to its balance-sheet balance via AcctNum', () => {
    expect(
      matchBalanceSheetAccount('Inventory Asset:Commercial Rx Inventory', accountNums, bsAccounts),
    ).toBe(102685.29);
    expect(
      matchBalanceSheetAccount('Inventory Asset:Lab Supplies Inventory', accountNums, bsAccounts),
    ).toBe(4986.07);
  });

  it('returns null when the account has no AcctNum', () => {
    expect(matchBalanceSheetAccount('Inventory Asset:Mystery', accountNums, bsAccounts)).toBeNull();
  });

  it('returns null when the balance sheet has no row for that AcctNum', () => {
    // '1220' (the parent) has an AcctNum but no leaf row on the balance sheet.
    expect(matchBalanceSheetAccount('Inventory Asset', accountNums, bsAccounts)).toBeNull();
  });

  it('does not confuse 1220.1 with 1220.10 (prefix must be followed by a space)', () => {
    const nums: Record<string, string> = { 'Inventory Asset:Short': '1220.1' };
    expect(matchBalanceSheetAccount('Inventory Asset:Short', nums, bsAccounts)).toBeNull();
  });
});
