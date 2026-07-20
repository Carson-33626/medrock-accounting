import { describe, it, expect } from 'vitest';
import { buildSummary, type DepositRecord } from './summary';

const NOW = new Date('2026-07-20T12:00:00Z');

function record(overrides: Partial<DepositRecord> & { fileId: string }): DepositRecord {
  return {
    fileId: overrides.fileId,
    fileName: overrides.fileName ?? `${overrides.fileId}.jpg`,
    webViewLink: overrides.webViewLink ?? `https://drive.google.com/file/d/${overrides.fileId}/view`,
    location: overrides.location ?? 'Florida',
    isoDate: overrides.isoDate ?? null,
    type: overrides.type ?? null,
    amount: overrides.amount ?? null,
    uploader: overrides.uploader ?? null,
  };
}

describe('buildSummary', () => {
  it('sorts newest first, with null dates last', () => {
    const records = [
      record({ fileId: 'a', isoDate: '2026-07-01' }),
      record({ fileId: 'b', isoDate: null }),
      record({ fileId: 'c', isoDate: '2026-07-15' }),
      record({ fileId: 'd', isoDate: '2026-06-30' }),
    ];

    const summary = buildSummary(records, ['Florida'], NOW);
    expect(summary.recent.map((r) => r.fileId)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('counts total files and this-month uploads', () => {
    const records = [
      record({ fileId: 'a', isoDate: '2026-07-19' }),
      record({ fileId: 'b', isoDate: '2026-06-30' }),
      record({ fileId: 'c', isoDate: null }),
    ];

    const summary = buildSummary(records, ['Florida'], NOW);
    expect(summary.totalFiles).toBe(3);
    expect(summary.thisMonthCount).toBe(1);
  });

  it('picks the most recent record by parsed date, not array order', () => {
    const records = [
      record({ fileId: 'a', isoDate: '2026-01-01' }),
      record({ fileId: 'b', isoDate: '2026-07-19' }),
      record({ fileId: 'c', isoDate: '2026-05-01' }),
    ];

    const summary = buildSummary(records, ['Florida'], NOW);
    expect(summary.mostRecent?.fileId).toBe('b');
  });

  it('returns null mostRecent for an empty record set', () => {
    expect(buildSummary([], [], NOW).mostRecent).toBeNull();
  });

  it('builds a per-location summary for every named location, including empty ones', () => {
    const records = [
      record({ fileId: 'a', location: 'Florida', isoDate: '2026-07-10' }),
      record({ fileId: 'b', location: 'Florida', isoDate: '2026-06-01' }),
      record({ fileId: 'c', location: 'Tennessee', isoDate: '2026-07-15' }),
    ];

    const summary = buildSummary(records, ['Florida', 'Tennessee', 'Texas'], NOW);
    const byName = Object.fromEntries(summary.locations.map((l) => [l.location, l]));

    expect(byName.Florida).toEqual({
      location: 'Florida',
      fileCount: 2,
      thisMonthCount: 1,
      latestUploadDate: '2026-07-10',
    });
    expect(byName.Tennessee).toEqual({
      location: 'Tennessee',
      fileCount: 1,
      thisMonthCount: 1,
      latestUploadDate: '2026-07-15',
    });
    // Texas has no uploads at all — still present, all zero/null.
    expect(byName.Texas).toEqual({
      location: 'Texas',
      fileCount: 0,
      thisMonthCount: 0,
      latestUploadDate: null,
    });
  });

  it('reports latestUploadDate as null for a location whose files all lack a derivable date', () => {
    const records = [record({ fileId: 'a', location: 'Florida', isoDate: null })];
    const summary = buildSummary(records, ['Florida'], NOW);
    expect(summary.locations[0]).toEqual({
      location: 'Florida',
      fileCount: 1,
      thisMonthCount: 0,
      latestUploadDate: null,
    });
  });

  it('caps recent at 50, keeping the newest', () => {
    const records = Array.from({ length: 60 }, (_, i) =>
      record({ fileId: `f${i}`, isoDate: `2026-01-${String((i % 27) + 1).padStart(2, '0')}` })
    );
    // Make one record unambiguously the newest.
    records.push(record({ fileId: 'newest', isoDate: '2026-07-19' }));

    const summary = buildSummary(records, ['Florida'], NOW);
    expect(summary.recent).toHaveLength(50);
    expect(summary.recent[0].fileId).toBe('newest');
  });
});
