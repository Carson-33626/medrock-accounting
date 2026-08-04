import { describe, it, expect } from 'vitest';
import { planDraftEnrichment } from './letco-enrich';
import type { DraftLine } from './letco-enrich';
import { LETCO_PRODUCT_ACCOUNT, LETCO_SHIPPING_ACCOUNT } from './letco-gl';

// Real shape of Kristina's FL draft c4ae2d36 for C335-176896, read back from Ramp 2026-08-04.
const herLines: DraftLine[] = [
  { amountCents: 500000, memo: 'Trichosol', coded: false },
  { amountCents: 16498, memo: 'Shipping & handling', coded: false },
];
const parsed = {
  lines: [{ itemNo: '697237', description: 'TrichoSol™', amountCents: 500000 }],
  shippingCents: 16498,
  totalCents: 516498,
};

describe('planDraftEnrichment', () => {
  it('codes her product line to inventory and her shipping line to COGS shipping', () => {
    const plan = planDraftEnrichment(herLines, parsed);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].account).toBe(LETCO_PRODUCT_ACCOUNT);
    expect(plan.lines[1].account).toBe(LETCO_SHIPPING_ACCOUNT);
  });

  it('preserves her amounts and her memos exactly', () => {
    const plan = planDraftEnrichment(herLines, parsed);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // PATCH replaces all line items, so anything we fail to echo back is DESTROYED.
    expect(plan.lines.map((l) => l.amountCents)).toEqual([500000, 16498]);
    expect(plan.lines.map((l) => l.memo)).toEqual(['Trichosol', 'Shipping & handling']);
  });

  it('refuses when any line is already coded, rather than overwriting her judgement', () => {
    const partly: DraftLine[] = [
      { amountCents: 500000, memo: 'Trichosol', coded: true },
      { amountCents: 16498, memo: 'Shipping & handling', coded: false },
    ];
    const plan = planDraftEnrichment(partly, parsed);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('already_coded');
  });

  it('refuses when her line total does not match the portal invoice total', () => {
    const wrong: DraftLine[] = [
      { amountCents: 400000, memo: 'Trichosol', coded: false },
      { amountCents: 16498, memo: 'Shipping & handling', coded: false },
    ];
    const plan = planDraftEnrichment(wrong, parsed);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('total_mismatch');
  });

  it('refuses when the shipping she identified does not equal the portal shipping residual', () => {
    // Same total, but she split it product-only — memo classification would silently code $164.98
    // of freight to inventory. The gate is what catches that.
    const mislabelled: DraftLine[] = [
      { amountCents: 500000, memo: 'Trichosol', coded: false },
      { amountCents: 16498, memo: 'Azelaic Acid', coded: false },
    ];
    const plan = planDraftEnrichment(mislabelled, parsed);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('shipping_mismatch');
  });

  it('handles a multi-line invoice with no shipping at all', () => {
    const multi: DraftLine[] = [
      { amountCents: 300000, memo: 'Item A', coded: false },
      { amountCents: 566000, memo: 'Item B', coded: false },
    ];
    const noShip = {
      lines: [
        { itemNo: '1', description: 'Item A', amountCents: 300000 },
        { itemNo: '2', description: 'Item B', amountCents: 566000 },
      ],
      shippingCents: 0,
      totalCents: 866000,
    };
    const plan = planDraftEnrichment(multi, noShip);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.every((l) => l.account === LETCO_PRODUCT_ACCOUNT)).toBe(true);
  });

  it('recognises freight wording other than the exact shipping memo', () => {
    const freight: DraftLine[] = [
      { amountCents: 500000, memo: 'Trichosol', coded: false },
      { amountCents: 16498, memo: 'FREIGHT CHARGE', coded: false },
    ];
    const plan = planDraftEnrichment(freight, parsed);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[1].account).toBe(LETCO_SHIPPING_ACCOUNT);
  });

  it('refuses an empty line set rather than patching a bill to nothing', () => {
    const plan = planDraftEnrichment([], parsed);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('no_lines');
  });

  it('splits shipping across multiple freight lines when they sum to the residual', () => {
    const twoFreight: DraftLine[] = [
      { amountCents: 500000, memo: 'Trichosol', coded: false },
      { amountCents: 8249, memo: 'Shipping', coded: false },
      { amountCents: 8249, memo: 'Handling', coded: false },
    ];
    const plan = planDraftEnrichment(twoFreight, parsed);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.filter((l) => l.account === LETCO_SHIPPING_ACCOUNT)).toHaveLength(2);
  });
});
