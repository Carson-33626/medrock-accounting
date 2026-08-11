import { describe, it, expect } from 'vitest';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from './entities';

describe('web-side entity table', () => {
  it('maps every entity to a QB location', () => {
    for (const e of ALL_ENTITIES) {
      expect(ENTITY_TO_QB_LOCATION[e]).toBeTruthy();
    }
  });

  // The cross-copy drift guard lived here until 2026-08-10. The receipt-enrichment program moved to
  // the repo root, so web/ can no longer import it. Entity/Location correctness is still guarded on
  // this side by the compiler-asserted pair in src/lib.
});
