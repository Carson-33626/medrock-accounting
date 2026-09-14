import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `accounting.payroll_journal_headers.id` is a BIGINT, and node-postgres hands a
 * bigint back as a STRING ('2855'). The lab-accrual card sends that id straight
 * to /api/payroll/approve, whose gate is `typeof headerId !== 'number'` -> 400
 * "headerId is required". Carson hit exactly that on the Approve button on
 * 2026-09-14. The payroll header mapper (`toHeader` in payroll/store) casts with
 * Number(); this list must too.
 */

type QueryFn = (
  sql: string,
  params?: ReadonlyArray<string | number>,
) => Promise<{ rows: Array<Record<string, string | null>>; rowCount: number }>;

const query = vi.fn<QueryFn>();

vi.mock('@/lib/rds', () => ({
  getRdsPool: () => ({ query }),
}));

vi.mock('@/lib/payroll/store', () => ({
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(),
  saveSourceSnapshot: vi.fn(),
}));

vi.mock('@/lib/quickbooks-multi', () => ({
  qbQueryAll: vi.fn(),
}));

import { listLabAccrualDrafts } from './lab-supplies-server';

beforeEach(() => {
  query.mockReset();
});

describe('listLabAccrualDrafts', () => {
  it('returns the header id as a number even though Postgres sends a bigint as a string', async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: '2855',
          entity: 'MedRock TN',
          kind: 'accrual',
          status: 'needs_review',
          qb_doc_number: null,
          txn_date: '2026-08-31',
          total_debits: '1234.56',
          total_credits: '1234.56',
          variance: '0',
        },
      ],
      rowCount: 1,
    });

    const { headers, linesById } = await listLabAccrualDrafts('2026-08');

    expect(headers).toHaveLength(1);
    expect(headers[0].id).toBe(2855);
    expect(typeof headers[0].id).toBe('number');
    expect(headers[0].total_debits).toBe(1234.56);
    expect(Object.keys(linesById)).toEqual(['2855']);
  });
});
