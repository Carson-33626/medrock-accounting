import { describe, it, expect, vi, beforeEach } from 'vitest';

interface HeaderFixture {
  id: string;
  entity: string;
  period_end: string;
  txn_date: string;
  period_segment: string;
  status: string;
  qb_doc_number: string;
  generated_at: string | null;
  posted_at: string | null;
}

const state: { headers: HeaderFixture[]; prefs: Array<{ AccountingInfoPrefs?: { BookCloseDate?: string } }> | Error } = {
  headers: [],
  prefs: [],
};

const query = vi.fn(async (sql: string) => {
  if (sql.includes('accounting.payroll_journal_headers')) return { rows: state.headers };
  return { rows: [] };
});

const getBalanceSheetInventory = vi.fn(async () => null);
const qbQueryAll = vi.fn(async (_location: string, entityName: string) => {
  if (entityName !== 'Preferences') return [];
  if (state.prefs instanceof Error) throw state.prefs;
  return state.prefs;
});

vi.mock('@/lib/rds', () => ({ getRdsPool: () => ({ query }) }));
vi.mock('@/lib/quickbooks-multi', () => ({
  getBalanceSheetInventory: () => getBalanceSheetInventory(),
  qbQueryAll: (location: string, entityName: string) => qbQueryAll(location, entityName),
}));
vi.mock('@/lib/payroll/qb-journal', () => ({ fetchDimensions: vi.fn(async () => null) }));

import { correctionOrderLock, fetchBookCloseDate } from './close-drift-server';

const posted = (id: number, month: string, entity = 'MedRock FL'): HeaderFixture => ({
  id: String(id),
  entity,
  period_end: `${month}-28`,
  txn_date: `${month}-28`,
  period_segment: '',
  status: 'posted',
  qb_doc_number: `${entity === 'MedRock FL' ? 'FL' : 'TX'} Inv Adj ${month.replace('-', '.')}`,
  generated_at: '2026-09-15T18:00:00Z',
  posted_at: '2026-09-15T18:30:00Z',
});

beforeEach(() => {
  query.mockClear();
  getBalanceSheetInventory.mockClear();
  qbQueryAll.mockClear();
  state.prefs = [{ AccountingInfoPrefs: { BookCloseDate: '2026-04-30' } }];
  // The 2026-10-27 FL state: Jan to May posted.
  state.headers = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((m, i) => posted(i + 1, m));
});

describe('fetchBookCloseDate', () => {
  it('reads Preferences.AccountingInfoPrefs.BookCloseDate', async () => {
    expect(await fetchBookCloseDate('MedRock FL')).toBe('2026-04-30');
    expect(qbQueryAll).toHaveBeenCalledWith('MedRock FL', 'Preferences');
  });

  it('is null when the books are not closed, and null (conservative) when the read fails', async () => {
    state.prefs = [{ AccountingInfoPrefs: {} }];
    expect(await fetchBookCloseDate('MedRock FL')).toBeNull();
    state.prefs = new Error('realm unreachable');
    expect(await fetchBookCloseDate('MedRock FL')).toBeNull();
  });
});

describe('correctionOrderLock — locked months', () => {
  it('May is correctable when every earlier posted month (Jan to Apr) is inside the closed period; no earlier balance sheet is read', async () => {
    expect(await correctionOrderLock('MedRock FL', '2026-05')).toBeNull();
    expect(getBalanceSheetInventory).not.toHaveBeenCalled();
  });

  it('without a close date the earlier months are consulted again (the old deadlock path)', async () => {
    state.prefs = [{ AccountingInfoPrefs: {} }];
    const reason = await correctionOrderLock('MedRock FL', '2026-05');
    expect(getBalanceSheetInventory).toHaveBeenCalled();
    expect(reason).toContain('2026-01');
  });

  it('an OPEN earlier month is still consulted: June reads May even though Jan to Apr are locked', async () => {
    const reason = await correctionOrderLock('MedRock FL', '2026-06');
    expect(getBalanceSheetInventory).toHaveBeenCalledTimes(1);
    expect(reason).toContain('2026-05');
  });

  it('an open correction draft in a locked month does not block May', async () => {
    state.headers = [...state.headers, { ...posted(9, '2026-04'), period_segment: 'C1', status: 'draft', qb_doc_number: 'FL Inv Adj 2026.04-2', posted_at: null }];
    expect(await correctionOrderLock('MedRock FL', '2026-05')).toBeNull();
  });
});
