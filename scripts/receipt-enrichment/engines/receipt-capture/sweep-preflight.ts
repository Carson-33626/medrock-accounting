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

// FL and TN are one JOINT ULINE account (different logins, shared invoice roster — confirmed
// 2026-07-29): a signed-in FL session sees TN's invoices too, so TN never needs its own bootstrap
// or session file. TX is a separate account and still needs its own session.
export function checkUline(stateDir: string): VendorAvailability {
  const hasFL = existsSync(join(stateDir, 'uline-FL.json'));
  const hasTX = existsSync(join(stateDir, 'uline-TX.json'));
  const entities: Entity[] = [...(hasFL ? (['FL', 'TN'] as Entity[]) : []), ...(hasTX ? (['TX'] as Entity[]) : [])];
  const needsYou: string[] = [];
  if (!hasFL) {
    needsYou.push(
      'ULINE FL: run  npx tsx scripts/receipt-enrichment/engines/receipt-capture/uline-bootstrap.ts --entity=FL  (headed human login) ' +
      '— TN rides FL\'s session (joint account, shared roster), no separate TN bootstrap needed',
    );
  }
  if (!hasTX) {
    needsYou.push('ULINE TX: run  npx tsx scripts/receipt-enrichment/engines/receipt-capture/uline-bootstrap.ts --entity=TX  (headed human login)');
  }
  return {
    vendor: 'uline',
    entities,
    available: entities.length > 0,
    detail: `sessions for ${[hasFL ? 'FL(+TN joint)' : null, hasTX ? 'TX' : null].filter(Boolean).join(',') || 'none'}`,
    needsYou: needsYou.length ? needsYou.join('\n') : null,
  };
}

// Letco is a BILL job, not a receipt job: it has zero Ramp card transactions, so it contributes
// nothing to the receiptless scan. It needs only portal creds — no browser, no bootstrap, no CDP.
export function checkLetco(env: NodeJS.ProcessEnv): VendorAvailability {
  const entities = ALL_ENTITIES.filter((e) => Boolean(env[`LETCO_${e}`]) && Boolean(env[`LETCO_${e}_Pass`]));
  const missing = ALL_ENTITIES.filter((e) => !entities.includes(e));
  return {
    vendor: 'letco',
    entities: [...entities],
    available: entities.length > 0,
    detail: `creds for ${entities.join(',') || 'none'}`,
    needsYou: missing.length ? `Letco creds missing for ${missing.join(', ')} (web/.env.local LETCO_<ENT> / LETCO_<ENT>_Pass)` : null,
  };
}

export function checkMedisca(env: NodeJS.ProcessEnv): VendorAvailability {
  const entities = ALL_ENTITIES.filter((e) => Boolean(env[`MEDISCA_${e}`]) && Boolean(env[`MEDISCA_${e}_Pass`]));
  const missing = ALL_ENTITIES.filter((e) => !entities.includes(e));
  return {
    vendor: 'medisca',
    entities: [...entities],
    available: entities.length > 0,
    detail: `creds for ${entities.join(',') || 'none'}`,
    needsYou: missing.length ? `Medisca creds missing for ${missing.join(', ')} (web/.env.local MEDISCA_<ENT> / MEDISCA_<ENT>_Pass)` : null,
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
