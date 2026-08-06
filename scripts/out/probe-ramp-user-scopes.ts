// Read-only probe: which Ramp OAuth scopes our per-entity API clients are granted.
// Only mints tokens (no API calls). users:read / users:write per entity.
import '../ramp-split-push/load-env';
import { rampToken } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'] as Entity[];

async function main(): Promise<void> {
  for (const e of ENTITIES) {
    for (const scope of ['users:read', 'users:write']) {
      try {
        await rampToken(e, scope);
        console.log(`${e} ${scope.padEnd(12)} GRANTED`);
      } catch (err) {
        console.log(`${e} ${scope.padEnd(12)} DENIED — ${(err as Error).message.slice(0, 120)}`);
      }
    }
  }
  process.exit(0);
}

void main();
