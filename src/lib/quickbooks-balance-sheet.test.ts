import { describe, it, expect } from 'vitest';
import {
  balanceSheetStartDate,
  buildBalanceSheetEndpoint,
  parseInventoryAssetSection,
} from './quickbooks-multi';

/**
 * Fixture modeled on the real QB BalanceSheet report tree (single end_date, so
 * each ColData is [label, amount]). The "1220 Inventory Asset" section sits under
 * ASSETS → Current Assets → Other Current Assets, with sub-accounts as leaf Data
 * rows and a "Total 1220 Inventory Asset" Summary. Values mirror FL 2026-06-30.
 */
const balanceSheetFixture = {
  Header: { ReportName: 'BalanceSheet' },
  Rows: {
    Row: [
      {
        Header: { ColData: [{ value: 'ASSETS' }] },
        Rows: {
          Row: [
            {
              Header: { ColData: [{ value: 'Current Assets' }] },
              Rows: {
                Row: [
                  {
                    Header: { ColData: [{ value: 'Other Current Assets' }] },
                    Rows: {
                      Row: [
                        {
                          Header: { ColData: [{ value: '1220 Inventory Asset', id: '92' }] },
                          Rows: {
                            Row: [
                              { ColData: [{ value: '1220.05 Commercial Rx Inventory', id: '93' }, { value: '100000.00' }], type: 'Data' },
                              { ColData: [{ value: '1220.10 Compound Ingredient Inventory', id: '94' }, { value: '400000.00' }], type: 'Data' },
                              { ColData: [{ value: '1220.15 Compound Packaging Inventory', id: '95' }, { value: '82727.63' }], type: 'Data' },
                              { ColData: [{ value: '1220.20 Lab Supplies Inventory', id: '96' }, { value: '100000.00' }], type: 'Data' },
                              { ColData: [{ value: '1220.25 OTC Items Inventory', id: '97' }, { value: '50000.00' }], type: 'Data' },
                              { ColData: [{ value: '1220.30 Shipping Packaging Material Inventory', id: '98' }, { value: '30000.00' }], type: 'Data' },
                              { ColData: [{ value: '1220.35 Inventory - Suspense (PrePaid)', id: '99' }, { value: '20000.00' }], type: 'Data' },
                            ],
                          },
                          Summary: { ColData: [{ value: 'Total 1220 Inventory Asset' }, { value: '782727.63' }] },
                          type: 'Section',
                        },
                      ],
                    },
                    Summary: { ColData: [{ value: 'Total Other Current Assets' }, { value: '900000.00' }] },
                    type: 'Section',
                  },
                ],
              },
              type: 'Section',
            },
          ],
        },
        type: 'Section',
      },
    ],
  },
};

describe('parseInventoryAssetSection', () => {
  it('extracts the section total from the "Total 1220 Inventory Asset" summary', () => {
    const parsed = parseInventoryAssetSection(balanceSheetFixture);
    expect(parsed).not.toBeNull();
    expect(parsed?.total).toBe(782727.63);
    expect(parsed?.accountName).toBe('1220 Inventory Asset');
  });

  it('extracts each sub-account name and value', () => {
    const parsed = parseInventoryAssetSection(balanceSheetFixture);
    expect(parsed?.accounts).toHaveLength(7);
    expect(parsed?.accounts[0]).toEqual({ name: '1220.05 Commercial Rx Inventory', value: 100000 });
    expect(parsed?.accounts.find((a) => a.name === '1220.15 Compound Packaging Inventory')?.value).toBe(82727.63);
    // sub-account values sum to the section total
    const sum = (parsed?.accounts ?? []).reduce((s, a) => s + a.value, 0);
    expect(Math.round(sum * 100) / 100).toBe(782727.63);
  });

  it('handles the TX shape (no OTC sub-account) without error', () => {
    const txFixture = structuredClone(balanceSheetFixture);
    const invRows = txFixture.Rows.Row[0].Rows.Row[0].Rows.Row[0].Rows.Row[0].Rows.Row;
    // drop the 1220.25 OTC row (absent in TX) and adjust the summary
    txFixture.Rows.Row[0].Rows.Row[0].Rows.Row[0].Rows.Row[0].Rows.Row = invRows.filter(
      (r) => !r.ColData[0].value.includes('OTC'),
    );
    txFixture.Rows.Row[0].Rows.Row[0].Rows.Row[0].Rows.Row[0].Summary.ColData[1].value = '732727.63';
    const parsed = parseInventoryAssetSection(txFixture);
    expect(parsed?.accounts).toHaveLength(6);
    expect(parsed?.total).toBe(732727.63);
  });

  it('returns null when there is no inventory-asset section', () => {
    const noInventory = { Rows: { Row: [{ Header: { ColData: [{ value: 'ASSETS' }] }, type: 'Section' }] } };
    expect(parseInventoryAssetSection(noInventory)).toBeNull();
  });

  it('returns null for an empty report', () => {
    expect(parseInventoryAssetSection({})).toBeNull();
  });
});

/**
 * Regression guard for the 2026-09-03 bug: QuickBooks silently ignores `end_date`
 * on the BalanceSheet report unless `start_date` is also sent. It still answers
 * 200 with a well-formed report, so the close page happily computed six different
 * months' adjustments against ONE set of balances (TN qbBookBalance 976,579.84 and
 * 1220.10 Compound Ingredient 630,754.05 came back identically for month=2026-03
 * and month=2026-06, while the FIFO target correctly moved 652,419.72 ->
 * 830,532.09). There is no runtime signal for this, so the test is the guard.
 */
describe('buildBalanceSheetEndpoint', () => {
  it('always sends start_date — without it QuickBooks ignores end_date', () => {
    const endpoint = buildBalanceSheetEndpoint('2026-03-31');
    expect(endpoint).toContain('start_date=');
    const params = new URLSearchParams(endpoint.slice(endpoint.indexOf('?') + 1));
    expect(params.get('start_date')).toBeTruthy();
    expect(params.get('end_date')).toBe('2026-03-31');
  });

  it('starts at Jan 1 of the as-of year', () => {
    // Any start_date works — probed 2026-09-03, 2000-01-01 and 2026-01-01 both return
    // 535,127.20 at end_date 2026-06-30. Same-year Jan 1 mirrors the proven sweep call.
    expect(balanceSheetStartDate('2026-06-30')).toBe('2026-01-01');
    expect(balanceSheetStartDate('2022-09-30')).toBe('2022-01-01');
    expect(balanceSheetStartDate('2026-01-31')).toBe('2026-01-01');
  });

  it('keeps start_date at or before the requested as-of date for every month we close', () => {
    // A start_date AFTER end_date is the one way this fix could silently break.
    for (const asOf of ['2022-09-30', '2025-12-31', '2026-02-28', '2026-03-31', '2026-08-31']) {
      const params = new URLSearchParams(
        buildBalanceSheetEndpoint(asOf).slice(buildBalanceSheetEndpoint(asOf).indexOf('?') + 1),
      );
      const start = params.get('start_date') ?? '';
      expect(start <= asOf).toBe(true);
    }
  });

  it('still requests the accrual basis, pinned minor version, and distinct dates per month', () => {
    const march = buildBalanceSheetEndpoint('2026-03-31');
    const june = buildBalanceSheetEndpoint('2026-06-30');
    expect(march).toContain('accounting_method=Accrual');
    expect(march).toContain('minorversion=75');
    expect(march).not.toBe(june);
  });
});
