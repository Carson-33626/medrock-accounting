// Resolve a GL account NAME (portable, from the classifier) to the entity-specific Ramp option id
// used as `field_option_external_id` in the PATCH. Account numbers are standardized across entities
// but the Ramp/QB internal ids differ per entity (FL Suspense=221, TN=315, TX=277), so we resolve
// against THIS entity's live chart, by name (primary) or acctnum/code (fallback). Never hardcode ids.
import { getRampAccounts } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

export interface GlIndex {
  byName: Map<string, string>; // account name -> option id
  byCode: Map<string, string>; // acctnum (code) -> option id
  suspenseId: string | null;
}

const SUSPENSE_CODE = '8220';

export async function buildGlIndex(entity: Entity, token: string): Promise<GlIndex> {
  const accounts = await getRampAccounts(entity, token);
  const byName = new Map<string, string>();
  const byCode = new Map<string, string>();
  for (const a of accounts) {
    if (a.name && !byName.has(a.name)) byName.set(a.name, a.id);
    if (a.code && !byCode.has(a.code)) byCode.set(a.code, a.id);
  }
  return { byName, byCode, suspenseId: byCode.get(SUSPENSE_CODE) ?? null };
}

// name first (classifier emits the QB account name verbatim), then acctnum as a fallback.
export function resolveGl(index: GlIndex, glName: string | null, acctnum: string | null): string | null {
  if (glName && index.byName.has(glName)) return index.byName.get(glName)!;
  if (acctnum && index.byCode.has(acctnum)) return index.byCode.get(acctnum)!;
  return null;
}
