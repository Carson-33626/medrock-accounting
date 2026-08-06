import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Entity } from './payroll/types';

// In-memory double for the one Supabase table quickbooks-multi.ts touches, so
// getValidTokens/storeTokens can be exercised without a real DB. Built via
// vi.hoisted because vi.mock factories can't close over outer-scope locals.
const { tokenRows, upsertCalls } = vi.hoisted(() => ({
  tokenRows: new Map<string, Record<string, unknown>>(),
  upsertCalls: [] as Record<string, unknown>[],
}));

vi.mock('./supabase-admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'accounting_quickbooks_tokens') throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: (_col: string, value: string) => ({
            single: async () => {
              const row = tokenRows.get(value);
              return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
            },
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          upsertCalls.push(row);
          tokenRows.set(row.location as string, row);
          return { error: null };
        },
      };
    },
  }),
}));

import { LOCATION_MAPPING, QB_TO_LOCATION_MAPPING, getValidTokens, fetchCompanyName, type Location } from './quickbooks-multi';

// Compile-time invariant: fetchDimensions(entity: Entity) in payroll/qb-journal.ts
// passes an Entity straight into qbQueryAll(location: Location) — the payroll and
// QuickBooks unions must carry identical string values. Entity -> Location is
// already proven by that call site; this asserts the reverse direction too, so a
// future Location with no matching Entity fails the build instead of failing at
// runtime the first time payroll touches it.
type AssertExtends<T extends U, U> = true;
type _EntityIsAssignableToLocation = AssertExtends<Entity, Location>;
type _LocationIsAssignableToEntity = AssertExtends<Location, Entity>;

describe('LOCATION_MAPPING', () => {
  it('includes FOCAS as the fourth location', () => {
    expect(LOCATION_MAPPING['FOCAS']).toBe('FOCAS Institute');
  });

  it('LOCATION_MAPPING and QB_TO_LOCATION_MAPPING are exact inverses', () => {
    const locEntries = Object.entries(LOCATION_MAPPING);
    const qbEntries = Object.entries(QB_TO_LOCATION_MAPPING);

    // Catches a stale/extra entry on either side, not just a missing one.
    expect(qbEntries).toHaveLength(locEntries.length);

    for (const [location, company] of locEntries) {
      expect(QB_TO_LOCATION_MAPPING[company as keyof typeof QB_TO_LOCATION_MAPPING]).toBe(location);
    }
    for (const [company, location] of qbEntries) {
      expect(LOCATION_MAPPING[location as keyof typeof LOCATION_MAPPING]).toBe(company);
    }
  });
});

describe('fetchCompanyName', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the QBO request fails', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false } as Response);
    await expect(fetchCompanyName('token', 'realm')).resolves.toBeNull();
  });

  it('returns null when CompanyInfo has no CompanyName', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ CompanyInfo: {} }),
    } as Response);
    await expect(fetchCompanyName('token', 'realm')).resolves.toBeNull();
  });

  it('returns the CompanyName on success', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ CompanyInfo: { CompanyName: 'Real Co' } }),
    } as Response);
    await expect(fetchCompanyName('token', 'realm')).resolves.toBe('Real Co');
  });
});

describe('token round trip (connect -> read-back -> refresh)', () => {
  const REAL_NAME = 'Medrock FLORIDA (real QBO CompanyInfo name)';

  beforeEach(() => {
    tokenRows.clear();
    upsertCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the real company_name through a read-back and a subsequent token refresh', async () => {
    // Seed the row the OAuth callback would have written at connect time: the
    // real CompanyInfo name, not the LOCATION_MAPPING placeholder.
    tokenRows.set('MedRock FL', {
      location: 'MedRock FL',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      realm_id: 'realm-1',
      company_name: REAL_NAME,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // not expired
    });

    // Read-back: getValidTokens must surface the stored real name.
    const readBack = await getValidTokens('MedRock FL');
    expect(readBack?.company_name).toBe(REAL_NAME);

    // Age the token out so the next call takes the refresh path.
    tokenRows.set('MedRock FL', {
      ...tokenRows.get('MedRock FL'),
      expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    });

    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
    } as Response);

    const refreshed = await getValidTokens('MedRock FL');
    expect(fetchMock).toHaveBeenCalled();
    expect(refreshed?.company_name).toBe(REAL_NAME);
    expect(refreshed?.company_name).not.toBe(LOCATION_MAPPING['MedRock FL']);

    // storeTokens (called internally by the refresh path) must have persisted
    // the real name rather than falling back to LOCATION_MAPPING.
    const lastUpsert = upsertCalls[upsertCalls.length - 1];
    expect(lastUpsert.company_name).toBe(REAL_NAME);
  });
});
