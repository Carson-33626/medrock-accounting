import { describe, it, expect } from 'vitest';
import { vendorGl } from './gl-defaults';
import { buildVendorSplit } from './vendor-split';
import type { VendorParsed } from './vendor-split';
import type { GlIndex } from '../amazon-enrich/gl-resolve';

// Minimal fake GlIndex: name/code -> entity-specific id. Field names match gl-resolve.GlIndex
// (byName / byCode / suspenseId — NOT byAcctnum, verified against the real file).
const index: GlIndex = {
  byName: new Map<string, string>([
    ['compound packaging inventory', '264'],
    ['lab supplies inventory', '1150040004'],
    ['office expense', '106'],
    ['commercial rx inventory', '250'],
  ]),
  byCode: new Map<string, string>([
    ['1220.15', '264'],
    ['1220.20', '1150040004'],
    ['6200.80', '106'],
    ['1220.05', '250'],
  ]),
  suspenseId: '999',
};

// Note: resolveGl looks up by exact glName string (index.byName.has(glName)) — the fake index's
// byName keys above are lowercased and would NOT match 'Compound Packaging Inventory' etc. exactly.
// Since acctnum is populated for every rule here, resolution falls through to the byCode branch,
// which does match. This mirrors resolveGl's real name-first/acctnum-fallback behavior.

describe('vendorGl', () => {
  it('maps ULINE categories per ratified conventions', () => {
    expect(vendorGl('uline', 'Jars, Jugs and Bottles', 'Dropper Bottles')).toEqual({ glName: 'Compound Packaging Inventory', acctnum: '1220.15' });
    expect(vendorGl('uline', 'Cleanroom Supplies', 'Clean Mat')).toEqual({ glName: 'Lab Supplies Inventory', acctnum: '1220.20' });
    expect(vendorGl('uline', 'Shelving and Storage', 'Steel Shelving')).toEqual({ glName: 'Office Expense', acctnum: '6200.80' });
    expect(vendorGl('uline', 'Never Heard Of It', 'Mystery')).toBeNull(); // fall through to classifier
  });
  it('defaults every TopRx product line to Commercial Rx Inventory', () => {
    expect(vendorGl('toprx', null, 'ATORVASTATIN 40MG TAB')).toEqual({ glName: 'Commercial Rx Inventory', acctnum: '1220.05' });
  });
});

describe('buildVendorSplit', () => {
  const parsed: VendorParsed = {
    layout: null, source: null, order: '52437036', glHint: null,
    items: [
      { desc: 'Graduated Glass Dropper Bottles - 1 oz', amountCents: 45600, category: 'Jars, Jugs and Bottles' },
      { desc: 'Tamper Resistant Labels', amountCents: 24000, category: 'Labels' },
    ],
    taxCents: 4872, shippingCents: 2500, tipCents: 0, parsedTotalCents: 76972,
  };
  it('sums exactly to the txn amount and codes via vendor map', () => {
    const split = buildVendorSplit('uline', parsed, 76972, index);
    expect(split).not.toBeNull();
    const sum = split!.lines.reduce((a, b) => a + b.amount, 0);
    expect(sum).toBe(76972);
    expect(split!.lines[0].accounting_field_selections[0].field_option_external_id).toBe('264');
    expect(split!.codedCount).toBe(2);
  });
  it('drops zero-amount Free Offers lines', () => {
    const withFree: VendorParsed = { ...parsed, items: [...parsed.items, { desc: 'Folding Table', amountCents: 0, category: 'Free Offers' }] };
    const split = buildVendorSplit('uline', withFree, 76972, index);
    expect(split!.lines).toHaveLength(2);
  });
  it('returns null when totals cannot reconcile', () => {
    expect(buildVendorSplit('uline', { ...parsed, items: [] }, 76972, index)).toBeNull();
  });
});
