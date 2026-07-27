// Vendor-level GL rules (ratified category->GL conventions, 2026-06-26 + spec §6).
// Returning null means: no vendor rule — fall through to the history classifier.
import type { Vendor } from './worklist';

export interface GlTarget { glName: string; acctnum: string }

const ULINE_CATEGORY_MAP: { re: RegExp; target: GlTarget }[] = [
  { re: /jars|jugs|bottles/i, target: { glName: 'Compound Packaging Inventory', acctnum: '1220.15' } },
  { re: /labels/i, target: { glName: 'Compound Packaging Inventory', acctnum: '1220.15' } },
  { re: /cleanroom|safety/i, target: { glName: 'Lab Supplies Inventory', acctnum: '1220.20' } },
  { re: /shelving|storage|bins|totes|facilities|maintenance/i, target: { glName: 'Office Expense', acctnum: '6200.80' } },
];

export function vendorGl(vendor: Vendor, category: string | null, desc: string): GlTarget | null {
  void desc; // reserved for future desc-level vendor rules
  if (vendor === 'toprx') {
    return { glName: 'Commercial Rx Inventory', acctnum: '1220.05' };
  }
  const cat = category ?? '';
  for (const { re, target } of ULINE_CATEGORY_MAP) {
    if (re.test(cat)) return target;
  }
  return null;
}
