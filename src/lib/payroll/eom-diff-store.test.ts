import { describe, it, expect, vi, beforeEach } from 'vitest';

type QueryFn = (sql: string, params?: ReadonlyArray<string | number | null | string[]>) => Promise<{ rows: never[]; rowCount: number }>;

const query = vi.fn<QueryFn>();

vi.mock('../rds', () => ({
  getRdsPool: () => ({ query }),
}));

import {
  getSettings, updateSettings, startRun, finishRun, latestRun, upsertCheck, listChecks, deleteCheck, deleteChecksNotIn,
  listPostedParentMonths, listPostedEomHeaderIds,
} from './eom-diff-store';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('eom-diff-store settings', () => {
  it('getSettings falls back to defaults when the row is missing', async () => {
    expect(await getSettings()).toEqual({ threshold: 1, enabled: true, checkFromMonth: '2026-03' });
  });

  it('getSettings coerces numeric strings', async () => {
    query.mockResolvedValueOnce({ rows: [{ threshold: '2.50', enabled: false, check_from_month: '2026-04' }] as never[], rowCount: 1 });
    expect(await getSettings()).toEqual({ threshold: 2.5, enabled: false, checkFromMonth: '2026-04' });
  });

  it('updateSettings builds SET from only the provided keys and stamps updated_by', async () => {
    query.mockResolvedValueOnce({
      rows: [{ threshold: '5.00', enabled: true, check_from_month: '2026-05' }] as never[],
      rowCount: 1,
    });
    const result = await updateSettings({ threshold: 5 }, 'd.carson@medrockpharmacy.com');
    const [sql, params] = query.mock.calls[0] as [string, Array<string | number | null>];
    expect(sql).toContain('threshold = $1');
    expect(sql).not.toContain('enabled = $');
    expect(sql).not.toContain('check_from_month = $');
    expect(sql).toContain('updated_by = $2');
    expect(sql).toContain('WHERE id = 1');
    expect(params).toEqual([5, 'd.carson@medrockpharmacy.com']);
    expect(result).toEqual({ threshold: 5, enabled: true, checkFromMonth: '2026-05' });
  });

  it('updateSettings includes every provided key in the SET clause', async () => {
    query.mockResolvedValueOnce({
      rows: [{ threshold: '2.00', enabled: false, check_from_month: '2026-06' }] as never[],
      rowCount: 1,
    });
    await updateSettings({ threshold: 2, enabled: false, checkFromMonth: '2026-06' }, null);
    const [sql, params] = query.mock.calls[0] as [string, Array<string | number | boolean | null>];
    expect(sql).toContain('threshold = $1');
    expect(sql).toContain('enabled = $2');
    expect(sql).toContain('check_from_month = $3');
    expect(sql).toContain('updated_by = $4');
    expect(params).toEqual([2, false, '2026-06', null]);
  });
});

describe('eom-diff-store runs', () => {
  it('startRun inserts the trigger and returns the new id', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 7 }] as never[], rowCount: 1 });
    expect(await startRun('manual')).toBe(7);
    const [sql, params] = query.mock.calls[0] as [string, string[]];
    expect(sql).toContain('INSERT');
    expect(params).toEqual(['manual']);
  });

  it('finishRun updates finished_at/ok/error by id', async () => {
    await finishRun(7, false, 'boom');
    const [sql, params] = query.mock.calls[0] as [string, Array<number | boolean | string | null>];
    expect(sql).toContain('finished_at = now()');
    expect(params).toEqual([7, false, 'boom']);
  });

  it('latestRun returns null when no row found', async () => {
    expect(await latestRun()).toBeNull();
  });

  it('latestRun maps the row to EomDiffRun', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 3, trigger: 'cron', started_at: '2026-09-25T00:00:00Z', finished_at: '2026-09-25T00:01:00Z',
        ok: true, error: null,
      }] as never[],
      rowCount: 1,
    });
    expect(await latestRun()).toEqual({
      id: 3, trigger: 'cron', startedAt: '2026-09-25T00:00:00Z', finishedAt: '2026-09-25T00:01:00Z', ok: true, error: null,
    });
  });
});

describe('eom-diff-store checks', () => {
  it('upsertCheck stringifies delta lines and keys on (month, entity)', async () => {
    await upsertCheck({ month: '2026-03', entity: 'MedRock FL', runId: 4, deltaLines: [], deltaDebits: 12.34, error: null });
    const [sql, params] = query.mock.calls[0] as [string, Array<string | number | null>];
    expect(sql).toContain('ON CONFLICT (month, entity)');
    expect(params).toEqual(['2026-03', 'MedRock FL', 4, '[]', 12.34, null]);
  });

  it('listChecks orders by month, entity and parses delta_lines jsonb into JournalLine[]', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        month: '2026-03', entity: 'MedRock FL', run_id: 4, checked_at: '2026-09-25T00:00:00Z',
        delta_lines: [{ postingType: 'Debit', amount: 5, accountName: 'Wages', memo: 'm' }],
        delta_debits: '5.00', error: null,
      }] as never[],
      rowCount: 1,
    });
    const [check] = await listChecks();
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain('ORDER BY month, entity');
    expect(check).toEqual({
      month: '2026-03', entity: 'MedRock FL', runId: 4, checkedAt: '2026-09-25T00:00:00Z',
      deltaLines: [{
        postingType: 'Debit', amount: 5, accountName: 'Wages', memo: 'm',
        departmentName: null, className: null, creditBucket: null, origin: 'inter_entity', sourceRowKeys: [],
      }],
      deltaDebits: 5,
      error: null,
    });
  });

  it('deleteCheck deletes one (month, entity) row', async () => {
    await deleteCheck('2026-03', 'MedRock TN');
    const [sql, params] = query.mock.calls[0] as [string, string[]];
    expect(sql).toContain('DELETE FROM accounting.eom_diff_checks');
    expect(sql).toContain('month = $1 AND entity = $2');
    expect(params).toEqual(['2026-03', 'MedRock TN']);
  });

  it('deleteChecksNotIn deletes every row whose month is not in the list', async () => {
    await deleteChecksNotIn(['2026-03', '2026-04']);
    const [sql, params] = query.mock.calls[0] as [string, [string[]]];
    expect(sql).toContain('DELETE FROM accounting.eom_diff_checks');
    expect(sql).toContain('NOT (month = ANY($1::text[]))');
    expect(params).toEqual([['2026-03', '2026-04']]);
  });

  it('listChecks drops malformed delta_lines items', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        month: '2026-03', entity: 'MedRock FL', run_id: 4, checked_at: '2026-09-25T00:00:00Z',
        delta_lines: [
          { postingType: 'Debit', amount: 5, accountName: 'Wages', memo: '' },
          { postingType: 'Bogus', amount: 5, accountName: 'Wages', memo: '' },
          { postingType: 'Credit', amount: 'nope', accountName: 'Wages', memo: '' },
          { postingType: 'Credit', amount: 5, accountName: 123, memo: '' },
          null,
          'nope',
        ],
        delta_debits: '5.00', error: null,
      }] as never[],
      rowCount: 1,
    });
    const [check] = await listChecks();
    expect(check.deltaLines).toEqual([{
      postingType: 'Debit', amount: 5, accountName: 'Wages', memo: '',
      departmentName: null, className: null, creditBucket: null, origin: 'inter_entity', sourceRowKeys: [],
    }]);
  });
});

describe('eom-diff-store posted lookups', () => {
  it('listPostedParentMonths filters parents from the given month', async () => {
    await listPostedParentMonths('2026-03');
    const [sql, params] = query.mock.calls[0] as [string, string[]];
    expect(sql).toContain("period_segment = ''");
    expect(sql).toContain("status = 'posted'");
    expect(params).toEqual(['2026-03']);
  });

  it('listPostedEomHeaderIds queries posted parent + corrections for the month/entity, ordered by segment', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] as never[], rowCount: 2 });
    const ids = await listPostedEomHeaderIds({ year: 2026, month: 3 }, 'MedRock FL');
    expect(ids).toEqual([1, 2]);
    const [sql, params] = query.mock.calls[0] as [string, string[]];
    expect(sql).toContain("status='posted'");
    expect(sql).toContain('ORDER BY period_segment');
    expect(params).toEqual(['03/31/2026', 'MedRock FL']);
  });
});
