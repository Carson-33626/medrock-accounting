import type { Entity } from './types';
const MAP: Record<string, Entity> = { MRFL: 'MedRock FL', MRTN: 'MedRock TN', MRTX: 'MedRock TX', FOCS: 'FOCAS' };
export const POSTABLE_ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX', 'FOCAS'];
export function entityForPayGroup(payGroup: string): Entity | null {
  return MAP[payGroup.trim().toUpperCase()] ?? null;
}
