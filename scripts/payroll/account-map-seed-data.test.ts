import { describe, it, expect } from 'vitest';
import { buildSeedAccountMap } from './account-map-seed-data';
import { POSTABLE_ENTITIES } from '../../src/lib/payroll/entity';

/**
 * Regression cover for the company-loan mapping (Barbara, 2026-07-20). Leaving this
 * column unmapped dropped its credit line while NET PAY already reflected the
 * deduction, which is what produced the FL ~$250 / TN $1,391.35 residuals.
 */
describe('COMPANY LOAN - EE - PRINCIPAL POST-TAX', () => {
  const COLUMN = 'COMPANY LOAN - EE - PRINCIPAL POST-TAX';

  it('is mapped for every postable entity', () => {
    for (const entity of POSTABLE_ENTITIES) {
      const matches = buildSeedAccountMap(entity).filter((r) => r.adpColumn === COLUMN);
      expect(matches, `${entity} should map ${COLUMN}`).toHaveLength(1);
    }
  });

  it('credits QBO 1215 Employee Advances, not the withholdings pool', () => {
    for (const entity of POSTABLE_ENTITIES) {
      const rule = buildSeedAccountMap(entity).find((r) => r.adpColumn === COLUMN);
      // Repaying an advance retires an asset — it must not land in the liability pool.
      expect(rule?.accountName).toBe('Employee Advances');
      expect(rule?.postingType).toBe('Credit');
      expect(rule?.costCenter).toBe('*');
      expect(rule?.active).toBe(true);
      expect(rule?.isCogs).toBe(false);
    }
  });
});
