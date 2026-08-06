import { describe, it, expect } from 'vitest';
import { LOCATION_MAPPING, QB_TO_LOCATION_MAPPING } from './quickbooks-multi';

describe('LOCATION_MAPPING', () => {
  it('includes FOCAS as the fourth location', () => {
    expect(LOCATION_MAPPING['FOCAS']).toBe('FOCAS Institute');
  });

  it('round-trips every location through the reverse mapping', () => {
    for (const [location, company] of Object.entries(LOCATION_MAPPING)) {
      expect(QB_TO_LOCATION_MAPPING[company as keyof typeof QB_TO_LOCATION_MAPPING]).toBe(location);
    }
  });
});
