import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadChargeStore } from './extraction-store';
import type { AmazonCharge } from './types';

const dir = mkdtempSync(join(tmpdir(), 'amz-store-'));
const path = join(dir, 'cache.json');
afterEach(() => { if (existsSync(path)) rmSync(path); });

const charge: AmazonCharge = { paymentRef: 'P1', orderIds: ['O1'], primaryOrderId: 'O1', accountGroup: 'g',
  chargeCents: 100, payDate: '2026-07-22', cardLast4: '9985', items: [], itemsTotalCents: 100 };

describe('loadChargeStore', () => {
  it('write-through persists and reloads by paymentRef', () => {
    const s = loadChargeStore(path);
    s.put({ charge, invoicePdfPath: null, fetchedAt: 'now' });
    expect(existsSync(path)).toBe(true);
    const reloaded = loadChargeStore(path);
    expect(reloaded.has('P1')).toBe(true);
    expect(reloaded.get('P1')!.charge.chargeCents).toBe(100);
    expect(reloaded.all()).toHaveLength(1);
  });
});
