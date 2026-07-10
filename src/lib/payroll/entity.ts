import type { Entity } from './types';
const MAP: Record<string, Entity> = { MRFL: 'MedRock FL', MRTN: 'MedRock TN', MRTX: 'MedRock TX' };
export const POSTABLE_ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
export function entityForPayGroup(payGroup: string): Entity | 'FOCS_EXCLUDED' | null {
  const g = payGroup.trim().toUpperCase();
  if (g === 'FOCS') return 'FOCS_EXCLUDED';
  return MAP[g] ?? null;
}
