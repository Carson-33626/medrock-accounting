import { describe, it, expect } from 'vitest';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from './entities';
import type { Entity } from './entities';

describe('web-side entity table', () => {
  it('maps every entity to a QB location', () => {
    for (const e of ALL_ENTITIES) {
      expect(ENTITY_TO_QB_LOCATION[e]).toBeTruthy();
    }
  });

  it('matches the receipt-enrichment program copy', async () => {
    const program = await import('../receipt-enrichment/engines/ramp-split-push/types');
    expect([...ALL_ENTITIES].sort()).toEqual([...program.ALL_ENTITIES].sort());
    for (const e of ALL_ENTITIES) {
      expect(ENTITY_TO_QB_LOCATION[e]).toBe(program.ENTITY_TO_QB_LOCATION[e as Entity]);
    }
  });
});
