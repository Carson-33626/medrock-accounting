import { describe, it, expect } from 'vitest';
import {
  correctionOrderReason,
  daysSinceMonthEnd,
  driftStatuses,
  earlyPostWarning,
  postOrderReason,
  type CloseHeaderRef,
} from './close-drift';
import { documentTouches } from './close-drift-server';

const h = (over: Partial<CloseHeaderRef> & Pick<CloseHeaderRef, 'id' | 'month'>): CloseHeaderRef => ({
  entity: 'MedRock TX',
  segment: '',
  status: 'posted',
  docNumber: null,
  generatedAt: '2026-09-15T18:00:00Z',
  postedAt: '2026-09-15T18:30:00Z',
  ...over,
});

describe('postOrderReason', () => {
  it('refuses the TX January draft: February already posted and absorbed it', () => {
    const jan = h({ id: 1, month: '2026-01', status: 'approved', postedAt: null, generatedAt: null, docNumber: null });
    const feb = h({ id: 2, month: '2026-02', docNumber: 'TX Inv Adj 2026.02' });
    const reason = postOrderReason(jan, [jan, feb]);
    expect(reason).toContain('TX Inv Adj 2026.02');
    expect(reason).toContain('twice');
  });

  it('refuses a draft generated before an earlier month posted — it is stale', () => {
    const jun = h({ id: 1, month: '2026-06', docNumber: 'TN Inv Adj 2026.06', postedAt: '2026-09-15T18:34:06Z' });
    const jul = h({ id: 2, month: '2026-07', status: 'approved', generatedAt: '2026-09-15T18:30:00Z', postedAt: null });
    expect(postOrderReason(jul, [jun, jul])).toContain('stale');
  });

  it('allows the chain as it actually ran on 09-15: generate, post, generate the next, post', () => {
    const jun = h({ id: 1, month: '2026-06', postedAt: '2026-09-15T18:34:06Z' });
    const jul = h({ id: 2, month: '2026-07', status: 'approved', generatedAt: '2026-09-15T18:34:55Z', postedAt: null });
    expect(postOrderReason(jul, [jun, jul])).toBeNull();
  });

  it('lets a June correction post after July and August posted — that is the drift fix', () => {
    const jun = h({ id: 1, month: '2026-06' });
    const junC = h({ id: 2, month: '2026-06', segment: 'C1', status: 'approved', generatedAt: '2026-09-20T10:00:00Z', postedAt: null });
    const jul = h({ id: 3, month: '2026-07' });
    const aug = h({ id: 4, month: '2026-08' });
    expect(postOrderReason(junC, [jun, junC, jul, aug])).toBeNull();
  });

  it('holds a July correction while June still has an open correction draft', () => {
    const junC = h({ id: 1, month: '2026-06', segment: 'C1', status: 'approved', postedAt: null, docNumber: null });
    const julC = h({ id: 2, month: '2026-07', segment: 'C1', status: 'approved', generatedAt: '2026-09-20T10:00:00Z', postedAt: null });
    expect(postOrderReason(julC, [junC, julC])).toContain('first');
  });

  it('counts the 12/31 opening entry as an earlier month', () => {
    const open = h({ id: 1, month: '2025-12', docNumber: 'TN Inv Open 2025.12', postedAt: '2026-09-15T16:16:14Z' });
    const jan = h({ id: 2, month: '2026-01', status: 'approved', generatedAt: '2026-09-15T16:00:00Z', postedAt: null });
    expect(postOrderReason(jan, [open, jan])).toContain('TN Inv Open 2025.12');
  });

  it('ignores other companies', () => {
    const tnFeb = h({ id: 1, month: '2026-02', entity: 'MedRock TN' });
    const txJan = h({ id: 2, month: '2026-01', status: 'approved', postedAt: null });
    expect(postOrderReason(txJan, [tnFeb, txJan])).toBeNull();
  });
});

describe('correctionOrderReason', () => {
  it('sends you to the earliest gapped month first', () => {
    const reason = correctionOrderReason('MedRock TN', '2026-08', [], [
      { month: '2026-05', gap: 41.82 },
      { month: '2026-06', gap: -3406.21 },
      { month: '2026-07', gap: -14633.02 },
    ]);
    expect(reason).toContain('correct 2026-06 first');
  });

  it('allows the correction once every earlier month ties', () => {
    expect(correctionOrderReason('MedRock TN', '2026-08', [], [{ month: '2026-07', gap: 54.64 }])).toBeNull();
  });

  it('blocks on an open earlier correction draft before reading any gap', () => {
    const open = h({ id: 9, month: '2026-06', entity: 'MedRock TN', segment: 'C1', status: 'draft', postedAt: null, docNumber: 'TN Inv Adj 2026.06-2' });
    expect(correctionOrderReason('MedRock TN', '2026-07', [open], [])).toContain('TN Inv Adj 2026.06-2');
  });
});

describe('driftStatuses', () => {
  it('flags only the earliest gapped month; later ones wait', () => {
    const s = driftStatuses([
      { month: '2026-05', gap: 412.5, openCorrection: false },
      { month: '2026-04', gap: 41.82, openCorrection: false },
      { month: '2026-06', gap: -3406.21, openCorrection: false },
    ]);
    expect(s.get('2026-04')).toBe('ties');
    expect(s.get('2026-05')).toBe('correct');
    expect(s.get('2026-06')).toBe('after');
  });

  it('an open correction draft holds everything after it', () => {
    const s = driftStatuses([
      { month: '2026-06', gap: -3406.21, openCorrection: true },
      { month: '2026-07', gap: -14633.02, openCorrection: false },
    ]);
    expect(s.get('2026-06')).toBe('open');
    expect(s.get('2026-07')).toBe('after');
  });
});

describe('earlyPostWarning', () => {
  it('warns when August is posted on 09-15, 15 days after it ended', () => {
    expect(daysSinceMonthEnd('2026-08', '2026-09-15')).toBe(15);
    expect(earlyPostWarning('2026-08', '2026-09-15')).toContain('15 days ago');
  });
  it('is silent from day 30 on', () => {
    expect(earlyPostWarning('2026-08', '2026-09-30')).toBeNull();
  });
});

describe('documentTouches', () => {
  const names = new Map([['101', 'Inventory Asset:Compound Ingredient Inventory'], ['5', 'Accounts Payable']]);
  it('signs vendor credits negative and rolls lines up per account', () => {
    const t = documentTouches(
      'VendorCredit',
      {
        Id: '1',
        DocNumber: 'VC-IAXS26195200006',
        TxnDate: '2026-03-13',
        Line: [
          { Amount: 7000, AccountBasedExpenseLineDetail: { AccountRef: { value: '101' } } },
          { Amount: 400, AccountBasedExpenseLineDetail: { AccountRef: { value: '101' } } },
        ],
      },
      names,
      new Map(),
    );
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ account: 'Inventory Asset:Compound Ingredient Inventory', amount: -7400 });
  });
  it('reads journal-entry debits up and credits down', () => {
    const t = documentTouches(
      'JournalEntry',
      {
        Id: '2',
        Line: [
          { Amount: 6750, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '101' } } },
          { Amount: 6750, JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '5' } } },
        ],
      },
      names,
      new Map(),
    );
    expect(t.find((x) => x.account.includes('Compound'))?.amount).toBe(6750);
    expect(t.find((x) => x.account === 'Accounts Payable')?.amount).toBe(-6750);
  });
});
