// Default 1/3 admin-wage split, adjustable later in the Mappings UI. TX carries the extra 0.0001%
// so the three sum to exactly 100.0000 (largest-remainder settles the pennies at build time).
import type { AllocationRule, Entity } from '../../src/lib/payroll/types';

export function buildSeedAllocationRules(effectiveFrom: string): AllocationRule[] {
  const pct: Record<Entity, number> = { 'MedRock FL': 33.3333, 'MedRock TN': 33.3333, 'MedRock TX': 33.3334 };
  return (Object.keys(pct) as Entity[]).map((e) => ({
    costCenter: 'ADMIN', targetEntity: e, percent: pct[e], effectiveFrom, active: true,
  }));
}
