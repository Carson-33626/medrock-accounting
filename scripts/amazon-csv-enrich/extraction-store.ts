// Per-login resumable cache: one CachedCharge per Payment Reference ID, plus the saved invoice PDF path.
// Write-through so a backfill survives a mid-run Chrome/session death. Namespace the path per login
// (e.g. out/<login>/charges.json) so the 3-login cycle never collides.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AmazonCharge } from './types';

export interface CachedCharge {
  charge: AmazonCharge;
  invoicePdfPath: string | null;
  fetchedAt: string;
}

export interface ChargeStore {
  has(paymentRef: string): boolean;
  get(paymentRef: string): CachedCharge | undefined;
  put(rec: CachedCharge): void;
  all(): CachedCharge[];
}

export function loadChargeStore(path: string): ChargeStore {
  const map = new Map<string, CachedCharge>();
  if (existsSync(path)) for (const r of JSON.parse(readFileSync(path, 'utf8')) as CachedCharge[]) map.set(r.charge.paymentRef, r);
  const flush = (): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify([...map.values()], null, 2)); };
  return {
    has: (id) => map.has(id),
    get: (id) => map.get(id),
    put: (rec) => { map.set(rec.charge.paymentRef, rec); flush(); },
    all: () => [...map.values()],
  };
}
