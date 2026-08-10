import type { Match, Drift } from './types';

export function classifyDrift(match: Match): Drift {
  return match.ramp.entity === match.qb.realm ? 'same_entity' : 'cross_entity';
}
