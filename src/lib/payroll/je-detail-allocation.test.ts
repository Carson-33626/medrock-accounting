import { describe, it, expect } from 'vitest';
import { buildAllocationJeDetailSheets } from './je-detail-allocation';
import { allocationBasis, buildMonthEndAllocation } from './month-end';
import type { PoolLine } from './qb-pool';
import type { CellValue } from '@/lib/inventory-export';
import type { EomEntity } from './revenue-rule';
import type { JournalDraft } from './types';

const MONTH = { year: 2026, month: 7 };
const SHARES: Record<EomEntity, number> = { 'MedRock FL': 50, 'MedRock TN': 30, 'MedRock TX': 20 };

function pool(overrides: Partial<PoolLine> & { amount: number }): PoolLine {
  return {
    entity: 'MedRock FL',
    txnType: 'JournalEntry',
    txnId: 'j1',
    txnDate: '2026-07-31',
    docNumber: null,
    accountName: '6000.10 Administrative Wages',
    className: 'Allocate - %',
    departmentName: '% Allocation',
    memo: null,
    rule: 'revenue',
    counterparty: null,
    ...overrides,
  };
}

const sum = (rows: Record<string, CellValue>[], key: 'debit' | 'credit'): number =>
  rows
    .filter((r) => r.role !== 'TOTAL')
    .reduce((s, r) => s + (typeof r[key] === 'number' ? Math.round(r[key] * 100) : 0), 0) / 100;

/** The drafts and the basis both come from the same pool — that is the point of the tie. */
function run(lines: PoolLine[]): { drafts: JournalDraft[]; basis: ReturnType<typeof allocationBasis> } {
  return {
    drafts: buildMonthEndAllocation(lines, SHARES, MONTH),
    basis: allocationBasis(lines, SHARES, MONTH),
  };
}

describe('buildAllocationJeDetailSheets', () => {
  it('foots to every entity of a revenue split, to the cent', () => {
    // $1,000.00 of FL admin wages at 50/30/20: FL keeps 500.00, sheds 500.00.
    const { drafts, basis } = run([pool({ amount: 1000 })]);
    expect(drafts.length).toBeGreaterThan(0);

    for (const draft of drafts) {
      const sheets = buildAllocationJeDetailSheets({
        entity: draft.entity,
        storedLines: draft.lines,
        basis,
        shares: SHARES,
        label: `${draft.entity} — % Allo 2026.07`,
      });
      expect(sheets, `${draft.entity} produced no sheet`).toHaveLength(1);
      expect(sum(sheets[0].rows, 'debit')).toBe(draft.totalDebits);
      expect(sum(sheets[0].rows, 'credit')).toBe(draft.totalCredits);
    }
  });

  it("states the pooled cost, the driver weight and this entity's share on one row", () => {
    const { drafts, basis } = run([pool({ amount: 1000 })]);
    const tn = drafts.find((d) => d.entity === 'MedRock TN');
    expect(tn).toBeDefined();

    const sheets = buildAllocationJeDetailSheets({
      entity: 'MedRock TN',
      storedLines: tn?.lines ?? [],
      basis,
      shares: SHARES,
      label: 'MedRock TN — % Allo 2026.07',
    });
    const received = sheets[0].rows.find((r) => r.account === '6000.10 Administrative Wages');
    expect(received).toMatchObject({
      role: 'Received from FL',
      heldBy: 'FL',
      pooled: 1000,
      weight: 30,
      debit: 300,
    });
    // The other side of the same movement: TN owes FL what it received.
    const ie = sheets[0].rows.find((r) => String(r.role).startsWith('Inter-entity'));
    expect(ie?.credit).toBe(300);
  });

  it('carries the 1/3 rule as a 33.33% weight, not a bare 1', () => {
    const { drafts, basis } = run([pool({ amount: 900, rule: 'thirds' })]);
    const tx = drafts.find((d) => d.entity === 'MedRock TX');
    const sheets = buildAllocationJeDetailSheets({
      entity: 'MedRock TX',
      storedLines: tx?.lines ?? [],
      basis,
      shares: SHARES,
      label: 'MedRock TX — % Allo 2026.07',
    });
    const row = sheets[0].rows.find((r) => r.account === '6000.10 Administrative Wages');
    expect(row?.weight).toBe(33.33);
    expect(row?.debit).toBe(300);
  });

  it('ships NOTHING when the pool snapshot no longer reproduces the stored entry', () => {
    const { drafts, basis } = run([pool({ amount: 1000 })]);
    const fl = drafts.find((d) => d.entity === 'MedRock FL');
    const tampered = (fl?.lines ?? []).map((l, i) => (i === 0 ? { ...l, amount: l.amount + 1 } : l));

    const sheets = buildAllocationJeDetailSheets({
      entity: 'MedRock FL',
      storedLines: tampered,
      basis,
      shares: SHARES,
      label: 'MedRock FL — % Allo 2026.07',
    });
    expect(sheets).toEqual([]);
  });

  it('foots across several accounts and rules in one entry', () => {
    const { drafts, basis } = run([
      pool({ amount: 1234.57 }),
      pool({ amount: 811.11, accountName: '6200.45 Software', rule: 'thirds' }),
      pool({ amount: 500, entity: 'MedRock TN', accountName: '6300.10 Rent', rule: 'fifty', counterparty: 'MedRock TX' }),
      pool({ amount: -120.5, accountName: '6200.45 Software', rule: 'thirds' }),
    ]);

    for (const draft of drafts) {
      const sheets = buildAllocationJeDetailSheets({
        entity: draft.entity,
        storedLines: draft.lines,
        basis,
        shares: SHARES,
        label: `${draft.entity} — % Allo 2026.07`,
      });
      expect(sheets, `${draft.entity} produced no sheet`).toHaveLength(1);
      expect(sum(sheets[0].rows, 'debit')).toBe(draft.totalDebits);
      expect(sum(sheets[0].rows, 'credit')).toBe(draft.totalCredits);
    }
  });
});
