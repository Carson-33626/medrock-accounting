import { describe, it, expect } from 'vitest';
import { parseInventoryAssetSection } from './quickbooks-multi';

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
