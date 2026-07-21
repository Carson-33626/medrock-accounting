import { describe, it, expect } from 'vitest';
import { compareJournalLines } from './line-order';

type Key = { accountName: string; memo: string | null; departmentName: string | null; className: string | null };
const k = (over: Partial<Key>): Key => ({ accountName: 'A', memo: null, departmentName: null, className: null, ...over });

describe('compareJournalLines', () => {
  it('orders by account name first', () => {
    expect(compareJournalLines(k({ accountName: 'Bravo' }), k({ accountName: 'Alpha' }))).toBeGreaterThan(0);
    expect(compareJournalLines(k({ accountName: 'Alpha' }), k({ accountName: 'Bravo' }))).toBeLessThan(0);
  });

  it('breaks ties on the same account by memo', () => {
    const admin = k({ accountName: 'Administrative Wages', memo: 'Admin Wages' });
    const acct = k({ accountName: 'Administrative Wages', memo: 'Accounting Wages' });
    // 'Accounting Wages' < 'Admin Wages' alphabetically → sorts before.
    expect(compareJournalLines(acct, admin)).toBeLessThan(0);
  });

  it('groups every line of one account adjacently when sorting an array', () => {
    const lines = [
      k({ accountName: 'Administrative Wages', memo: 'Admin Wages' }),
      k({ accountName: 'Customer Service Wages', memo: null }),
      k({ accountName: 'Administrative Wages', memo: 'Accounting Wages' }),
    ];
    const sorted = [...lines].sort(compareJournalLines);
    const accounts = sorted.map((l) => l.accountName);
    // The two Administrative Wages lines must be contiguous.
    const first = accounts.indexOf('Administrative Wages');
    const last = accounts.lastIndexOf('Administrative Wages');
    expect(last - first).toBe(1);
    // And Accounting Wages comes before Admin Wages within that group.
    expect(sorted[first].memo).toBe('Accounting Wages');
    expect(sorted[first + 1].memo).toBe('Admin Wages');
  });

  it('is a stable total order (null memo/dept/class handled without throwing)', () => {
    const a = k({ accountName: 'X', memo: null, departmentName: null, className: null });
    const b = k({ accountName: 'X', memo: null, departmentName: 'Miami', className: null });
    expect(compareJournalLines(a, b)).toBeLessThan(0); // null dept sorts before a named one
    expect(compareJournalLines(a, k({ accountName: 'X' }))).toBe(0); // fully equal
  });
});
