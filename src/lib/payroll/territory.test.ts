import { describe, it, expect } from 'vitest';
import { resolveRepTerritory, resolveDirector } from './territory';

describe('resolveRepTerritory', () => {
  it('matches a "Last, First" payroll name to market + title', () => {
    expect(resolveRepTerritory('Denha, Veronica')).toEqual({ market: 'Miami Region', title: 'Senior Territory Manager' });
  });
  it('honors a confirmed name alias (Wilhoit, Robert -> Rob Wilhoit)', () => {
    expect(resolveRepTerritory('Wilhoit, Robert')).toEqual({ market: 'Carolina Region', title: 'Senior Territory Manager' });
  });
  it('returns null for a non-rep', () => {
    expect(resolveRepTerritory('Nobody, Random')).toBeNull();
  });
});

describe('resolveDirector', () => {
  it('resolves Lockwood by his ADP name (Lucas != Luke) to East director', () => {
    // He is NOT a territory rep, so resolveRepTerritory misses him — directors are the fallback.
    expect(resolveRepTerritory('Lockwood, Lucas R')).toBeNull();
    expect(resolveDirector('Lockwood, Lucas R')).toEqual({ division: 'East', title: 'Marketing Director East' });
  });
  it('resolves Mitchell to West director (source East/West un-swapped)', () => {
    expect(resolveDirector('Mitchell, Tiffany Bell')).toEqual({ division: 'West', title: 'Marketing Director West' });
  });
  it('returns null for a non-director', () => {
    expect(resolveDirector('Denha, Veronica')).toBeNull();
  });
});
