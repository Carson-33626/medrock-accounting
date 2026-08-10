// What separates one big-box retailer pipeline from another. Everything downstream of extraction —
// matcher, split builder, GL resolution, receipt PDF, write path, audit — is identical between Walmart and
// Sam's Club, so the differences live here as data rather than as a forked runner.
//
// Sam's Club shares Walmart's account system but is a distinct site with its own order-history DOM and
// invoice layout, so it needs its own CDP extractor; that extractor writes the same ExtractedOrder cache
// shape, which is what lets everything after it stay shared.
import { WM } from '../../paths';

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
  // Anchored at the start so a future "Walmart Fuel"/"Walmart Pharmacy" is still Walmart, but a
  // descriptor that merely CONTAINS the word (e.g. "WALMART.COM SAMS") cannot be swallowed here and then
  // missed by the Sam's profile. Ramp reports these two as exactly "Walmart" and "Sam's Club" today.
  merchantPattern: /^walmart\b/i,
  cacheFile: `${WM.out}/extraction-cache.json`,
  pdfDir: WM.receipts,
  outDir: WM.out,
};

export const SAMS: RetailerProfile = {
  key: 'sams',
  label: "Sam's Club",
  // `.?` covers the straight apostrophe, the curly U+2019 Ramp sometimes emits, and no apostrophe at all;
  // a literal `'` would silently match nothing on a curly variant.
  merchantPattern: /sam.?s\s*club/i,
  cacheFile: `${WM.out}/sams/extraction-cache.json`,
  pdfDir: `${WM.receipts}/sams`,
  outDir: `${WM.out}/sams`,
};

export const PROFILES: Record<string, RetailerProfile> = { walmart: WALMART, sams: SAMS };

export function resolveProfile(key: string): RetailerProfile {
  const p = PROFILES[key];
  if (!p) throw new Error(`Unknown --retailer ${key} (expected ${Object.keys(PROFILES).join(' or ')})`);
  return p;
}
