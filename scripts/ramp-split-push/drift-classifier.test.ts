import { describe, it, expect } from 'vitest';
import { classifyDrift } from './drift-classifier';
import type { Match, QBEntry, RampTxn } from './types';

function mk(qbRealm: 'FL' | 'TN' | 'TX', cardEntity: 'FL' | 'TN' | 'TX'): Match {
  const qb: QBEntry = { realm: qbRealm, qbEntryId: 'q', docType: 'Purchase', orderNo: '1', txnDate: '2026-03-01', totalCents: 100, vendor: 'Amazon Business', lines: [] };
  const ramp: RampTxn = { id: 'r', entity: cardEntity, amountCents: 100, date: '2026-03-01', cardId: 'c', cardHolder: null, memo: null, merchantName: 'Amazon', orderNo: '1', priorLineItems: null };
  return { qb, ramp, tier: 'order_no' };
}

describe('classifyDrift', () => {
  it('same entity when card entity equals QB realm', () => {
    expect(classifyDrift(mk('FL', 'FL'))).toBe('same_entity');
  });
  it('cross entity when card entity differs from QB realm', () => {
    expect(classifyDrift(mk('TN', 'FL'))).toBe('cross_entity');
  });
});
