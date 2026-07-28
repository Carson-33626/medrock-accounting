// S0: which vendors can run right now? Missing access is a checklist item, never a failure.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Entity } from '../ramp-split-push/types';
import { ALL_ENTITIES } from '../ramp-split-push/types';

export interface VendorAvailability {
  vendor: string;
  entities: Entity[];
  available: boolean;
  detail: string;
  needsYou: string | null;
}

export function checkTopRx(env: NodeJS.ProcessEnv): VendorAvailability {
  const entities = ALL_ENTITIES.filter((e) => Boolean(env[`TopRX_${e}`]) && Boolean(env[`TopRX_${e}_Pass`]));
  const missing = ALL_ENTITIES.filter((e) => !entities.includes(e));
  return {
    vendor: 'toprx',
    entities: [...entities],
    available: entities.length > 0,
    detail: `creds for ${entities.join(',') || 'none'}`,
    needsYou: missing.length ? `TopRx creds missing for ${missing.join(', ')} (web/.env.local TopRX_<ENT> / TopRX_<ENT>_Pass)` : null,
  };
}

export function checkUline(stateDir: string): VendorAvailability {
  const entities = ALL_ENTITIES.filter((e) => existsSync(join(stateDir, `uline-${e}.json`)));
  const missing = ALL_ENTITIES.filter((e) => !entities.includes(e));
  return {
    vendor: 'uline',
    entities: [...entities],
    available: entities.length > 0,
    detail: `sessions for ${entities.join(',') || 'none'}`,
    needsYou: missing.length
      ? missing.map((e) => `ULINE ${e}: run  npx tsx scripts/receipt-capture/uline-bootstrap.ts --entity=${e}  (headed human login)`).join('\n')
      : null,
  };
}

export async function checkCdp(url: string, timeoutMs = 1500): Promise<{ reachable: boolean; detail: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/json/version`, { signal: ac.signal });
    return { reachable: res.ok, detail: res.ok ? `Chrome CDP at ${url}` : `HTTP ${res.status} from ${url}` };
  } catch (e: unknown) {
    return { reachable: false, detail: `no Chrome at ${url}: ${(e as Error).message}` };
  } finally {
    clearTimeout(t);
  }
}
