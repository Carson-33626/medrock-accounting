import { describe, it, expect } from 'vitest';
import {
  recordSku, classifySku, joinInvoiceLines, buildSkuHistory, toSkuMapFile, fromSkuMapFile,
} from './medisca-sku';
import type { SkuHistory } from './medisca-sku';

function historyOf(pairs: [string, string][]): SkuHistory {
  const h: SkuHistory = new Map();
  for (const [sku, acct] of pairs) recordSku(h, sku, acct);
  return h;
}

describe('classifySku', () => {
  it('resolves a SKU she has always coded the same way', () => {
    const h = historyOf([['3066-03', '1220.10'], ['3066-03', '1220.10'], ['3066-03', '1220.10']]);
    expect(classifySku('3066-03', h)).toEqual({ account: '1220.10', reason: 'sku(3)' });
  });

  it('resolves on a SINGLE observation — a SKU is exact, unlike prose', () => {
    expect(classifySku('7378-02', historyOf([['7378-02', '1220.15']])).account).toBe('1220.15');
  });

  it('refuses a SKU coded two ways, without taking the majority', () => {
    // Stricter than the description gate on purpose: a SKU is product identity, so disagreement is a
    // real judgement call rather than fuzzy-match noise.
    const h = historyOf([
      ...Array<[string, string]>(9).fill(['1234-01', '1220.10']),
      ['1234-01', '1500.02'],
    ]);
    const v = classifySku('1234-01', h);
    expect(v.account).toBeNull();
    expect(v.reason).toContain('sku_ambiguous');
    expect(v.reason).toContain('1500.02');
  });

  it('refuses a SKU never seen', () => {
    expect(classifySku('9999-99', historyOf([])).reason).toBe('sku_unknown');
  });
});

describe('joinInvoiceLines', () => {
  it('joins lines by amount', () => {
    const obs = joinInvoiceLines(
      [{ sku: '0008-05', amountCents: 130000 }, { sku: '2529-07', amountCents: 568000 }],
      [{ account: '1220.10', amountCents: 130000 }, { account: '1220.20', amountCents: 568000 }],
    );
    expect(obs).toEqual([
      { sku: '0008-05', account: '1220.10' },
      { sku: '2529-07', account: '1220.20' },
    ]);
  });

  it('REFUSES to learn from duplicated amounts on the portal side', () => {
    // The three $120 glove lines. Guessing here would teach a wrong SKU permanently.
    const obs = joinInvoiceLines(
      [{ sku: '5742-01', amountCents: 12000 }, { sku: '5743-01', amountCents: 12000 }],
      [{ account: '1220.20', amountCents: 12000 }, { account: '1220.20', amountCents: 12000 }],
    );
    expect(obs).toEqual([]);
  });

  it('refuses when the QuickBooks side has the ambiguity instead', () => {
    const obs = joinInvoiceLines(
      [{ sku: '0008-05', amountCents: 5000 }],
      [{ account: '1220.10', amountCents: 5000 }, { account: '1220.20', amountCents: 5000 }],
    );
    expect(obs).toEqual([]);
  });

  it('learns the unambiguous lines even when others on the same invoice collide', () => {
    const obs = joinInvoiceLines(
      [
        { sku: '5742-01', amountCents: 12000 },
        { sku: '5743-01', amountCents: 12000 },
        { sku: '0008-05', amountCents: 130000 },
      ],
      [
        { account: '1220.20', amountCents: 12000 },
        { account: '1220.20', amountCents: 12000 },
        { account: '1220.10', amountCents: 130000 },
      ],
    );
    expect(obs).toEqual([{ sku: '0008-05', account: '1220.10' }]);
  });

  it('ignores a QuickBooks line with no account', () => {
    expect(joinInvoiceLines(
      [{ sku: '0008-05', amountCents: 5000 }],
      [{ account: '', amountCents: 5000 }],
    )).toEqual([]);
  });

  it('ignores a portal line with no QuickBooks counterpart', () => {
    // Back-ordered lines are on the order but not the bill; they must teach nothing.
    expect(joinInvoiceLines(
      [{ sku: '3066-06', amountCents: 433500 }],
      [{ account: '1220.10', amountCents: 345000 }],
    )).toEqual([]);
  });
});

describe('sku map persistence', () => {
  const history = buildSkuHistory([
    { sku: '3066-03', account: '1220.10' },
    { sku: '3066-03', account: '1220.10' },
    { sku: '7378-02', account: '1220.15' },
    { sku: '1234-01', account: '1220.10' },
    { sku: '1234-01', account: '1500.02' },
  ]);

  it('separates resolved SKUs from contested ones', () => {
    const file = toSkuMapFile(history, '2026-08-05T00:00:00.000Z');
    expect(file.resolved).toEqual({ '3066-03': '1220.10', '7378-02': '1220.15' });
    expect(Object.keys(file.ambiguous)).toEqual(['1234-01']);
    expect(file.ambiguous['1234-01'].sort()).toEqual(['1220.10', '1500.02']);
  });

  it('round-trips WITHOUT promoting a contested SKU to resolved', () => {
    // If ambiguity did not survive reload, the next run would confidently code a SKU that two
    // accounts are competing for.
    const reloaded = fromSkuMapFile(toSkuMapFile(history, '2026-08-05T00:00:00.000Z'));
    expect(classifySku('1234-01', reloaded).account).toBeNull();
    expect(classifySku('3066-03', reloaded).account).toBe('1220.10');
  });

  it('learned the two SKUs that needed human rulings on 2026-08-05', () => {
    // Bimatoprost and the MD Syringe both had to be ruled by hand because the description path could
    // not resolve them. The SKU map derives both from her own history.
    const file = toSkuMapFile(history, '2026-08-05T00:00:00.000Z');
    expect(file.resolved['3066-03']).toBe('1220.10');
    expect(file.resolved['7378-02']).toBe('1220.15');
  });
});
