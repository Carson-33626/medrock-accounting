import { describe, it, expect, vi, beforeEach } from 'vitest';

type QueryFn = (sql: string, params?: ReadonlyArray<string | number | string[]>) => Promise<{ rows: never[]; rowCount: number }>;

const query = vi.fn<QueryFn>();

vi.mock('../rds', () => ({
  getRdsPool: () => ({ query }),
}));

import { saveEomRun, getEomRun, listEomHeaders, deleteUnpostedEomHeaders, listEomCorrectionHeaders } from './eom-store';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('eom-store', () => {
  it('listEomHeaders converts the Month into the ADP month-end pay_date', async () => {
    await listEomHeaders({ year: 2026, month: 3 });
    const [, params] = query.mock.calls[0] as [string, ReadonlyArray<string>];
    expect(params[0]).toBe('03/31/2026');
  });

  it('deleteUnpostedEomHeaders passes the month-end pay_date and the keepEntities array through', async () => {
    await deleteUnpostedEomHeaders({ year: 2026, month: 3 }, ['MedRock FL']);
    const [, params] = query.mock.calls[0] as [string, [string, string[]]];
    expect(params[0]).toBe('03/31/2026');
    expect(params[1]).toEqual(['MedRock FL']);
  });

  it('saveEomRun stringifies the pool/revenue/attention params', async () => {
    await saveEomRun({ month: '2026-03', pool: [{ a: 1 }], revenue: { b: 2 }, attention: [] });
    const [, params] = query.mock.calls[0] as [string, [string, string, string, string]];
    expect(params[0]).toBe('2026-03');
    expect(params[1]).toBe(JSON.stringify([{ a: 1 }]));
    expect(params[2]).toBe(JSON.stringify({ b: 2 }));
    expect(params[3]).toBe(JSON.stringify([]));
  });

  it('getEomRun queries by month and returns null when no row found', async () => {
    const result = await getEomRun('2026-03');
    expect(result).toBeNull();
    const [, params] = query.mock.calls[0] as [string, [string]];
    expect(params[0]).toBe('2026-03');
  });

  it('listEomHeaders returns only the parent rows (period_segment empty)', async () => {
    await listEomHeaders({ year: 2026, month: 3 });
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain("period_segment = ''");
  });

  it('deleteUnpostedEomHeaders never deletes correction rows', async () => {
    await deleteUnpostedEomHeaders({ year: 2026, month: 3 }, ['MedRock FL']);
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain("period_segment = ''");
  });

  it('listEomCorrectionHeaders returns only C-rows for the month', async () => {
    await listEomCorrectionHeaders({ year: 2026, month: 3 });
    const [sql, params] = query.mock.calls[0] as [string, string[]];
    expect(sql).toContain("period_segment LIKE 'C%'");
    expect(params[0]).toBe('03/31/2026');
  });
  it('listEomCorrectionHeaders sorts corrections numerically by index (C2 before C10)', async () => {
    await listEomCorrectionHeaders({ year: 2026, month: 3 });
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain('ORDER BY entity, substring(period_segment from 2)::int');
  });
});
