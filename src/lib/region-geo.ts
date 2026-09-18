// Where each marketer region sits on the Regions map. Keyed by display name (the stored name
// minus ", Marketer"). A region missing here still lists in the table — it just has no spot on
// the map, and the page says so. Metro names must exist in METRO_POINTS (us-map-paths.ts);
// add new ones via scripts/gen-us-map.mjs.

export interface RegionGeo {
  /** Postal codes of the states this region covers. */
  states: string[];
  /** Key into METRO_POINTS when the region is a metro rather than a whole state. */
  metro?: string;
}

export const REGION_GEO: Record<string, RegionGeo> = {
  Alabama: { states: ['AL'] },
  Arizona: { states: ['AZ'] },
  'Austin Region': { states: ['TX'], metro: 'Austin' },
  'Carolina Region': { states: ['NC', 'SC'] },
  'Colorado Region': { states: ['CO'] },
  'Dallas Region': { states: ['TX'], metro: 'Dallas' },
  'Houston Region': { states: ['TX'], metro: 'Houston' },
  Illinois: { states: ['IL'] },
  'Jacksonville Region': { states: ['FL'], metro: 'Jacksonville' },
  Maryland: { states: ['MD'] },
  'Miami Region': { states: ['FL'], metro: 'Miami' },
  Michigan: { states: ['MI'] },
  'New England': { states: ['ME', 'NH', 'VT', 'MA', 'RI', 'CT'] },
  'North Georgia': { states: ['GA'], metro: 'North Georgia' },
  'Ohio Region': { states: ['OH'] },
  'Orlando Region': { states: ['FL'], metro: 'Orlando' },
  Pennsylvania: { states: ['PA'] },
  'South Georgia': { states: ['GA'], metro: 'South Georgia' },
  'Tampa Region': { states: ['FL'], metro: 'Tampa' },
  Tennessee: { states: ['TN'] },
};
