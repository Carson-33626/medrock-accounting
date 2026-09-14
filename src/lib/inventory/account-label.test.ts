import { describe, it, expect } from 'vitest';
import { formatAccount } from './account-label';

const NUMS = {
  'Inventory Asset': '1220',
  'Inventory Asset:Commercial Rx Inventory': '1220.05',
  'Cost of Goods Sold:Compound Ingredient': '5000.10',
};

describe('formatAccount', () => {
  it('prints number then leaf name, the way the balance sheet does', () => {
    expect(formatAccount('Inventory Asset:Commercial Rx Inventory', NUMS)).toBe('1220.05 Commercial Rx Inventory');
    expect(formatAccount('Cost of Goods Sold:Compound Ingredient', NUMS)).toBe('5000.10 Compound Ingredient');
  });

  it('handles a parent account with no colon', () => {
    expect(formatAccount('Inventory Asset', NUMS)).toBe('1220 Inventory Asset');
  });

  it('falls back to the full name when no number is known', () => {
    expect(formatAccount('Inventory Asset:OTC Items Inventory', NUMS)).toBe('Inventory Asset:OTC Items Inventory');
    expect(formatAccount('Inventory Asset:Commercial Rx Inventory', null)).toBe('Inventory Asset:Commercial Rx Inventory');
    expect(formatAccount('Inventory Asset:Commercial Rx Inventory', undefined)).toBe('Inventory Asset:Commercial Rx Inventory');
  });
});
