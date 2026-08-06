import { describe, it, expect } from 'vitest';
import { entityForPayGroup, POSTABLE_ENTITIES } from './entity';
describe('entityForPayGroup', () => {
  it('maps pay groups to QB companies', () => {
    expect(entityForPayGroup('MRFL')).toBe('MedRock FL');
    expect(entityForPayGroup('MRTN')).toBe('MedRock TN');
    expect(entityForPayGroup('MRTX')).toBe('MedRock TX');
    expect(entityForPayGroup('FOCS')).toBe('FOCAS');
  });
  it('returns null for unknown pay groups', () => {
    expect(entityForPayGroup('ZZZ')).toBeNull();
  });
  it('lists FOCAS as postable', () => {
    expect(POSTABLE_ENTITIES).toContain('FOCAS');
  });
});
