import { describe, it, expect } from 'vitest';
import { buildSplit } from './split';
import type { ParsedReceipt } from './receipt-parser';
import type { GlIndex } from './gl-resolve';

const index: GlIndex = { byName: new Map([['Office', 'opt-office']]), byCode: new Map(), suspenseId: 'opt-susp' };

function receipt(p: Partial<ParsedReceipt>): ParsedReceipt {
  return { layout: 'WMT', source: 'walmart', order: null, glHint: null, items: [], taxCents: 0, shippingCents: 0, tipCents: 0, parsedTotalCents: 0, ...p };
}

describe('buildSplit', () => {
  it('distributes tax+shipping+tip so lines sum EXACTLY to the charge', () => {
    const parsed = receipt({
      items: [{ desc: 'thing a', amountCents: 20997 }, { desc: 'thing b', amountCents: 944 }, { desc: 'thing c', amountCents: 512 }],
      taxCents: 1684, shippingCents: 0, tipCents: 400, parsedTotalCents: 24537,
    });
    const built = buildSplit(parsed, 24537, index);
    expect(built).not.toBeNull();
    const sum = built!.lines.reduce((a, l) => a + l.amount, 0);
    expect(sum).toBe(24537);
    expect(built!.lines).toHaveLength(3);
  });

  it('returns null when there are no positive item amounts', () => {
    expect(buildSplit(receipt({ items: [] }), 100, index)).toBeNull();
  });

  it('falls back to Suspense id when a line is unclassified', () => {
    const parsed = receipt({ items: [{ desc: 'zzz unknown', amountCents: 100 }], parsedTotalCents: 100 });
    const built = buildSplit(parsed, 100, index);
    expect(built!.lines[0].accounting_field_selections[0].field_option_external_id).toBe('opt-susp');
  });
});
