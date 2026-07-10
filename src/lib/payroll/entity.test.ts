import { describe, it, expect } from 'vitest';
import { entityForPayGroup } from './entity';
describe('entityForPayGroup', () => {
  it('maps pay groups to QB companies', () => {
    expect(entityForPayGroup('MRFL')).toBe('MedRock FL');
    expect(entityForPayGroup('MRTN')).toBe('MedRock TN');
    expect(entityForPayGroup('MRTX')).toBe('MedRock TX');
  });
  it('flags FOCS as excluded and unknown as null', () => {
    expect(entityForPayGroup('FOCS')).toBe('FOCS_EXCLUDED');
    expect(entityForPayGroup('ZZZ')).toBeNull();
  });
});
