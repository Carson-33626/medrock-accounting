import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStore } from './extraction-store';
import type { ExtractedOrder } from './extraction-store';

function rec(p: Partial<ExtractedOrder>): ExtractedOrder {
  return { orderId: '200013207850010', date: '2025-06-11', totalCents: 24537, items: [{ desc: 'x', amountCents: 24537 }], taxCents: 0, shippingCents: 0, tipCents: 0, parsedTotalCents: 24537, pdfPath: 'p.pdf', fetchedAt: '2026-07-13T00:00:00Z', ...p };
}

describe('extraction-store', () => {
  it('write-through: put persists immediately and survives reload', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'wm-')), 'cache.json');
    const a = loadStore(p);
    expect(a.has('200013207850010')).toBe(false);
    a.put(rec({}));
    const b = loadStore(p); // fresh load, no explicit save() call
    expect(b.has('200013207850010')).toBe(true);
    expect(b.get('200013207850010')?.parsedTotalCents).toBe(24537);
    expect(b.all()).toHaveLength(1);
  });
});
