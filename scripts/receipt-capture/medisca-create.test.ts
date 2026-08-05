import { describe, it, expect } from 'vitest';
import { planMediscaCreate } from './medisca-create';
import type { CreateInput, CreateContext } from './medisca-create';
import { buildSkuHistory } from './medisca-sku';
import { recordHistory } from './medisca-gl';
import type { MediscaHistory } from './medisca-gl';
import { buildRulings } from './medisca-rulings';
import type { OrderLine } from './medisca-order';

function order(sku: string, name: string, amountCents: number, lot = ''): OrderLine {
  return { sku, name, qty: 1, backOrdered: 0, unitPriceCents: amountCents, amountCents, lot };
}

const descriptionHistory: MediscaHistory = new Map();
recordHistory(descriptionHistory, 'Hydroquinone USP', '1220.10');

const ctx: CreateContext = {
  skuHistory: buildSkuHistory([
    { sku: '3066-03', account: '1220.10' },
    { sku: '5743-01', account: '1220.20' },
    { sku: '1234-01', account: '1220.10' },
    { sku: '1234-01', account: '1500.02' },  // contested
  ]),
  descriptionHistory,
  rulings: buildRulings(),
};

/** The real single-line Bimatoprost invoice, 04245588. */
function bimatoprost(over: Partial<CreateInput> = {}): CreateInput {
  return {
    invoiceNumberRaw: '04245588',
    listTotalCents: 345000,
    pdfLines: [{ amountCents: 345000, unitPriceCents: 345000, text: 'Bimatoprost (Frozen)' }],
    pdfTotals: { subtotalCents: 345000, totalCents: 345000 },
    orderLines: [order('3066-03', 'Bimatoprost', 345000), order('3066-06', 'Bimatoprost', 433500)],
    ...over,
  };
}

/** The real 3-glove invoice with its -$10 shipping credit, 04245590. */
function gloves(over: Partial<CreateInput> = {}): CreateInput {
  return {
    invoiceNumberRaw: '04245590',
    listTotalCents: 35000,
    pdfLines: [
      { amountCents: 12000, unitPriceCents: 600, text: 'Gloves, Blue Nitrile Powder-Free' },
      { amountCents: 12000, unitPriceCents: 600, text: 'Gloves, Blue Nitrile Powder-Free' },
      { amountCents: 12000, unitPriceCents: 600, text: 'Gloves, Blue Nitrile Powder-Free' },
    ],
    pdfTotals: { subtotalCents: 36000, totalCents: 35000 },
    orderLines: [
      order('5743-01', 'Nitrile Gloves 9" 4mil', 12000, '223592/A'),
      order('5742-01', 'Nitrile Gloves 9" 4mil', 12000, '228530/A'),
      order('5744-01', 'Nitrile Gloves 9" 4mil', 12000, '228531/A'),
    ],
    ...over,
  };
}

describe('reconcile gates', () => {
  it('refuses when the PDF total disagrees with the list row', () => {
    const plan = planMediscaCreate(bimatoprost({ listTotalCents: 999900 }), ctx);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('total_mismatch');
  });

  it('refuses when the billed lines do not sum to the PDF subtotal', () => {
    // A silently dropped line is the failure that would otherwise yield a plausible, wrong draft.
    const plan = planMediscaCreate(gloves({
      pdfLines: [{ amountCents: 12000, unitPriceCents: 600, text: 'Gloves' }],
    }), ctx);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('lines_do_not_sum');
  });

  it('refuses a $0 free-goods invoice rather than inventing a cost/credit pair', () => {
    const plan = planMediscaCreate(bimatoprost({ listTotalCents: 0 }), ctx);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('zero_dollar');
  });

  it('refuses when the totals block could not be read', () => {
    const plan = planMediscaCreate(bimatoprost({ pdfTotals: null }), ctx);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('no_totals');
  });

  it('refuses when no billed line was parsed', () => {
    const plan = planMediscaCreate(bimatoprost({ pdfLines: [] }), ctx);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('no_lines');
  });
});

describe('billed lines, not ordered lines', () => {
  it('bills only the shipped Bimatoprost and ignores the back-ordered one', () => {
    const plan = planMediscaCreate(bimatoprost(), ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].amountCents).toBe(345000);
    expect(plan.lines.reduce((a, l) => a + l.amountCents, 0)).toBe(345000);
  });

  it('codes it from the SKU — the item that needed a human ruling this morning', () => {
    const plan = planMediscaCreate(bimatoprost(), ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].account).toBe('1220.10');
    expect(plan.lines[0].reason).toContain('sku');
    expect(plan.lines[0].sku).toBe('3066-03');
  });
});

describe('the derived adjustment line', () => {
  it('adds the -$10 shipping credit so the draft totals the invoice', () => {
    const plan = planMediscaCreate(gloves(), ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.adjustmentCents).toBe(-1000);
    const credit = plan.lines[plan.lines.length - 1];
    expect(credit.amountCents).toBe(-1000);
    expect(credit.account).toBe('5000.45');
    expect(credit.memo).toMatch(/credit/i);
  });

  it('makes the planned lines sum to the invoice total exactly', () => {
    const plan = planMediscaCreate(gloves(), ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.reduce((a, l) => a + l.amountCents, 0)).toBe(35000);
  });

  it('adds no adjustment line when the invoice has none', () => {
    const plan = planMediscaCreate(bimatoprost(), ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.adjustmentCents).toBe(0);
    expect(plan.lines.every((l) => l.reason !== 'derived_adjustment')).toBe(true);
  });
});

describe('SKU joining', () => {
  it('refuses to attach a SKU when three lines share one amount', () => {
    // All three gloves are $120, so no line can be attributed to a specific SKU by amount.
    const plan = planMediscaCreate(gloves(), ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    for (const l of plan.lines.filter((x) => x.reason !== 'derived_adjustment')) {
      expect(l.sku).toBe('');
    }
  });

  it('falls back to the PDF description when no SKU can be joined', () => {
    const plan = planMediscaCreate(gloves(), ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].memo).toBe('Gloves, Blue Nitrile Powder-Free');
  });

  it('prefers the order page name and lot when the join IS clean', () => {
    const plan = planMediscaCreate(bimatoprost(), ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].memo).toBe('Bimatoprost');
  });

  it('carries the lot into the memo when present', () => {
    const plan = planMediscaCreate({
      invoiceNumberRaw: '1', listTotalCents: 37200,
      pdfLines: [{ amountCents: 37200, unitPriceCents: 37200, text: 'Hydroquinone USP' }],
      pdfTotals: { subtotalCents: 37200, totalCents: 37200 },
      orderLines: [order('0075-01', 'Hydroquinone USP', 37200, '230072/J')],
    }, ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].memo).toBe('Hydroquinone USP Lot:230072/J');
  });
});

describe('coded vs uncoded', () => {
  it('marks a draft coded only when EVERY line resolved', () => {
    const plan = planMediscaCreate(bimatoprost(), ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.coded).toBe(true);
  });

  it('still creates the draft, uncoded, when a line cannot be classified', () => {
    // The data entry is the labour being removed; an uncoded draft still delivers it.
    const plan = planMediscaCreate({
      invoiceNumberRaw: '1', listTotalCents: 5200,
      pdfLines: [{ amountCents: 5200, unitPriceCents: 5200, text: 'Something Never Bought' }],
      pdfTotals: { subtotalCents: 5200, totalCents: 5200 },
      orderLines: [order('9999-99', 'Something Never Bought', 5200)],
    }, ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.coded).toBe(false);
    expect(plan.lines[0].account).toBeNull();
  });

  it('leaves a contested SKU uncoded rather than taking the majority', () => {
    const plan = planMediscaCreate({
      invoiceNumberRaw: '1', listTotalCents: 1000,
      pdfLines: [{ amountCents: 1000, unitPriceCents: 1000, text: 'Contested Thing' }],
      pdfTotals: { subtotalCents: 1000, totalCents: 1000 },
      orderLines: [order('1234-01', 'Contested Thing', 1000)],
    }, ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.coded).toBe(false);
  });

  it('falls through to the description history when the SKU is unknown', () => {
    const plan = planMediscaCreate({
      invoiceNumberRaw: '1', listTotalCents: 37200,
      pdfLines: [{ amountCents: 37200, unitPriceCents: 37200, text: 'Hydroquinone USP' }],
      pdfTotals: { subtotalCents: 37200, totalCents: 37200 },
      orderLines: [order('0000-00', 'Hydroquinone USP', 37200)],
    }, ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].account).toBe('1220.10');
    expect(plan.lines[0].reason).toContain('history');
  });

  it('never codes a line to a capitalisation account by inference', () => {
    // 1500.02 only ever reaches a line through an unanimous SKU or her own consistent description
    // history — never through a majority vote or a fallback.
    const plan = planMediscaCreate({
      invoiceNumberRaw: '1', listTotalCents: 1000,
      pdfLines: [{ amountCents: 1000, unitPriceCents: 1000, text: 'Contested Thing' }],
      pdfTotals: { subtotalCents: 1000, totalCents: 1000 },
      orderLines: [order('1234-01', 'Contested Thing', 1000)],
    }, ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].account).not.toBe('1500.02');
  });
});

describe('order-page fallback for image-only PDFs', () => {
  // Every invoice before 2026-08-03 is a scan with no text layer, so this is the NORMAL state of
  // the historical backlog, not an edge case.
  it('builds the draft from order lines when the order shipped complete', () => {
    const plan = planMediscaCreate({
      invoiceNumberRaw: '04231928', listTotalCents: 342000,
      pdfLines: [], pdfTotals: null,
      orderLines: [order('3066-03', 'Bimatoprost', 342000)],
    }, ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].amountCents).toBe(342000);
    expect(plan.lines[0].account).toBe('1220.10');
    expect(plan.lines[0].sku).toBe('3066-03');
  });

  it('REFUSES a partially billed order — the sums cannot agree', () => {
    // Order carries $7,785 of lines but the invoice billed only $3,450; the rest back-ordered.
    // Using the order lines would overstate this bill by more than double.
    const plan = planMediscaCreate({
      invoiceNumberRaw: '04245588', listTotalCents: 345000,
      pdfLines: [], pdfTotals: null,
      orderLines: [order('3066-06', 'Bimatoprost', 433500), order('3066-03', 'Bimatoprost', 345000)],
    }, ctx);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('no_lines');
    expect(plan.detail).toContain('partially billed');
  });

  it('still refuses when there are no order lines either', () => {
    const plan = planMediscaCreate({
      invoiceNumberRaw: '1', listTotalCents: 1000,
      pdfLines: [], pdfTotals: null, orderLines: [],
    }, ctx);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('no_lines');
  });

  it('never invents an adjustment through the fallback — sums matched exactly by construction', () => {
    const plan = planMediscaCreate({
      invoiceNumberRaw: '1', listTotalCents: 342000,
      pdfLines: [], pdfTotals: null,
      orderLines: [order('3066-03', 'Bimatoprost', 342000)],
    }, ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.adjustmentCents).toBe(0);
  });
});
