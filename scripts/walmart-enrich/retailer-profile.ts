// What separates one big-box retailer pipeline from another. Everything downstream of extraction —
// matcher, split builder, GL resolution, receipt PDF, write path, audit — is identical between Walmart and
// Sam's Club, so the differences live here as data rather than as a forked runner.
//
// Sam's Club shares Walmart's account system but is a distinct site with its own order-history DOM and
// invoice layout, so it needs its own CDP extractor; that extractor writes the same ExtractedOrder cache
// shape, which is what lets everything after it stay shared.
export type RetailerKey = 'walmart' | 'sams';

export interface RetailerProfile {
  key: RetailerKey;         // audit vendor + receipt idempotency-key prefix + PDF filenames
  label: string;
  merchantPattern: RegExp;  // tested against Ramp merchant_name
  cacheFile: string;        // extraction cache written by this retailer's CDP extractor
  pdfDir: string;
  outDir: string;
}

export const WALMART: RetailerProfile = {
  key: 'walmart',
  label: 'Walmart',
  // Anchored so it cannot swallow Sam's Club: Ramp reports that merchant as "Sam's Club", but a loose
  // /walmart/i would still match descriptors like "WALMART.COM SAMS" if Ramp ever normalises differently.
  merchantPattern: /walmart/i,
  cacheFile: 'scripts/walmart-enrich/out/extraction-cache.json',
  pdfDir: 'scripts/walmart-enrich/.receipts_cache',
  outDir: 'scripts/walmart-enrich/out',
};

export const SAMS: RetailerProfile = {
  key: 'sams',
  label: "Sam's Club",
  merchantPattern: /sam'?s club/i,
  cacheFile: 'scripts/walmart-enrich/out/sams/extraction-cache.json',
  pdfDir: 'scripts/walmart-enrich/.receipts_cache/sams',
  outDir: 'scripts/walmart-enrich/out/sams',
};

export const PROFILES: Record<string, RetailerProfile> = { walmart: WALMART, sams: SAMS };

export function resolveProfile(key: string): RetailerProfile {
  const p = PROFILES[key];
  if (!p) throw new Error(`Unknown --retailer ${key} (expected ${Object.keys(PROFILES).join(' or ')})`);
  return p;
}
