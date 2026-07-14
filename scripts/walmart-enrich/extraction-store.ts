// The persistent extraction cache ("lookup list"): parsed Walmart invoice per order id + saved PDF
// path. Write-through on every put() so the historical backfill is resumable — a mid-run crash or
// session expiry keeps everything already extracted. Re-runs read this and never re-fetch a known order.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ExtractedOrder {
  orderId: string;
  date: string;
  totalCents: number;
  items: { desc: string; amountCents: number }[];
  taxCents: number;
  shippingCents: number;
  tipCents: number;
  parsedTotalCents: number;
  pdfPath: string;
  fetchedAt: string;
}

export interface ExtractionStore {
  has(orderId: string): boolean;
  get(orderId: string): ExtractedOrder | undefined;
  put(rec: ExtractedOrder): void;
  remove(orderId: string): void;
  all(): ExtractedOrder[];
}

export function loadStore(path: string): ExtractionStore {
  const map = new Map<string, ExtractedOrder>();
  if (existsSync(path)) for (const r of JSON.parse(readFileSync(path, 'utf8')) as ExtractedOrder[]) map.set(r.orderId, r);
  const flush = (): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify([...map.values()], null, 2)); };
  return {
    has: (id) => map.has(id),
    get: (id) => map.get(id),
    put: (rec) => { map.set(rec.orderId, rec); flush(); },
    remove: (id) => { if (map.delete(id)) flush(); },
    all: () => [...map.values()],
  };
}
