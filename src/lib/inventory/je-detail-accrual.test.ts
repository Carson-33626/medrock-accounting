import { describe, it, expect } from 'vitest';
import {
  buildLabAccrualJeDetailSheets,
  parseLabAccrualSnapshot,
  type LabAccrualSnapshot,
} from './je-detail-accrual';
import { buildLabAccrualDrafts } from './lab-supplies-je';
import { computeAccrual, ACCRUAL_PARAMETERS } from './lab-supplies-accrual';
import type { CellValue } from '@/lib/inventory-export';
import type { JsonValue } from '@/lib/payroll/store';
import type { JournalLine } from '@/lib/payroll/types';

/**
 * The snapshot and the drafts come from ONE `computeAccrual` call, which is the whole point of
 * the tie: the sheet is a view of the entry, never a second opinion about it.
 */
function scenario(observedToDate: number, observedDocs: number, asOf = '2026-09-04') {
  const location = 'MedRock TN' as const;
  const month = '2026-08';
  const result = computeAccrual({ location, monthEnd: '2026-08-31', asOf, observedToDate, observedDocs });
  const snapshot: LabAccrualSnapshot = {
    location,
    month,
    asOf,
    observedToDate,
    observedDocs,
    normalDocs: ACCRUAL_PARAMETERS.normalDocsPerMonth[location],
    daysElapsed: result.daysElapsed,
    curveCompleteness: result.curveCompleteness,
    entryCompleteness: result.entryCompleteness,
    completeness: result.completeness,
    boundBy: result.boundBy,
    trailingAverage: result.trailingAverage,
    accrual: result.accrual,
    estimatedTotal: result.estimatedTotal,
    flagged: result.flagged,
    flagReason: result.flagReason,
    borrowedCurve: result.borrowedCurve,
  };
  const pair = buildLabAccrualDrafts({
    location,
    month,
    accrual: result.accrual,
    completeness: result.completeness,
    boundBy: result.boundBy,
  });
  if (pair === null) throw new Error('scenario produced nothing to accrue');
  return { snapshot, pair };
}

const cell = (rows: Record<string, CellValue>[], step: string, key: string): CellValue =>
  rows.find((r) => r.step === step)?.[key] ?? null;

const total = (rows: Record<string, CellValue>[], key: 'debit' | 'credit'): number =>
  rows.find((r) => r.step === 'TOTAL')?.[key] as number;

describe('buildLabAccrualJeDetailSheets', () => {
  it('foots to the accrual entry, and its TOTAL row equals both sides', () => {
    const { snapshot, pair } = scenario(1200, 3);
    const [sheet] = buildLabAccrualJeDetailSheets({
      storedLines: pair.accrual.lines,
      snapshot,
      kind: 'accrual',
      label: 'MedRock TN — LS Accru 2026.08 — 2026-08-31',
    });

    expect(sheet.name).toBe('Accrual basis');
    expect(total(sheet.rows, 'debit')).toBeCloseTo(snapshot.accrual, 2);
    expect(total(sheet.rows, 'credit')).toBeCloseTo(snapshot.accrual, 2);
    expect(total(sheet.rows, 'debit')).toBeCloseTo(pair.accrual.totalDebits, 2);
  });

  it('foots to the reversal, whose Dr/Cr are the mirror of the accrual', () => {
    const { snapshot, pair } = scenario(1200, 3);
    const [sheet] = buildLabAccrualJeDetailSheets({
      storedLines: pair.reversal.lines,
      snapshot,
      kind: 'reversal',
      label: 'MedRock TN — LS Accru 2026.08R — 2026-09-01',
    });

    expect(total(sheet.rows, 'debit')).toBeCloseTo(snapshot.accrual, 2);
    // The reversal debits the liability and credits the expense — the opposite of the accrual.
    const drRow = sheet.rows.find((r) => r.step === 'Dr');
    const crRow = sheet.rows.find((r) => r.step === 'Cr');
    expect(drRow?.basis).toBe('Accrued Expenses');
    expect(crRow?.basis).toBe('Cost of Goods Sold:Lab Supplies');
    expect(sheet.note).toContain('REVERSAL half');
  });

  it('shows the model as a chain a reader can re-derive by hand', () => {
    const { snapshot, pair } = scenario(1200, 3);
    const [sheet] = buildLabAccrualJeDetailSheets({
      storedLines: pair.accrual.lines, snapshot, kind: 'accrual', label: 'x',
    });

    expect(cell(sheet.rows, 'Observed to date', 'amount')).toBe(1200);
    expect(cell(sheet.rows, 'Observed to date', 'value')).toBe('3 documents');
    expect(cell(sheet.rows, 'Trailing monthly average', 'amount')).toBe(snapshot.trailingAverage);
    expect(cell(sheet.rows, 'Completeness applied', 'value')).toBe(`${(snapshot.completeness * 100).toFixed(1)}%`);
    expect(cell(sheet.rows, 'Accrual', 'amount')).toBe(snapshot.accrual);
    expect(cell(sheet.rows, 'Estimated month total', 'amount')).toBe(snapshot.estimatedTotal);
    // (1 − completeness) × trailing average, straight off the sheet.
    expect((1 - snapshot.completeness) * snapshot.trailingAverage).toBeCloseTo(snapshot.accrual, 2);
  });

  it('ships NOTHING when the snapshot no longer reproduces the entry', () => {
    const { snapshot, pair } = scenario(1200, 3);
    const stale: LabAccrualSnapshot = { ...snapshot, accrual: snapshot.accrual + 0.01 };
    expect(
      buildLabAccrualJeDetailSheets({ storedLines: pair.accrual.lines, snapshot: stale, kind: 'accrual', label: 'x' }),
    ).toEqual([]);
  });

  it('ships nothing for an entry that is not the two-line pair the builder emits', () => {
    const { snapshot, pair } = scenario(1200, 3);
    const extra: JournalLine = { ...pair.accrual.lines[0] };
    expect(
      buildLabAccrualJeDetailSheets({
        storedLines: [...pair.accrual.lines, extra], snapshot, kind: 'accrual', label: 'x',
      }),
    ).toEqual([]);
  });

  it('surfaces a flagged estimate as its own row rather than burying it in the note', () => {
    // Nothing keyed at all: entry completeness 0, so the accrual is a full trailing month and
    // the low-estimate flag fires.
    const { snapshot, pair } = scenario(0, 0);
    const [sheet] = buildLabAccrualJeDetailSheets({
      storedLines: pair.accrual.lines, snapshot, kind: 'accrual', label: 'x',
    });
    expect(snapshot.completeness).toBe(0);
    expect(cell(sheet.rows, 'Accrual', 'amount')).toBe(snapshot.trailingAverage);
    if (snapshot.flagged) expect(cell(sheet.rows, 'FLAGGED', 'basis')).toBe(snapshot.flagReason);
  });
});

describe('parseLabAccrualSnapshot', () => {
  const good = (): { [k: string]: JsonValue } => ({
    location: 'MedRock TN', month: '2026-08', asOf: '2026-09-04',
    observedToDate: 1200, observedDocs: 3, normalDocs: 6, daysElapsed: 4,
    curveCompleteness: 0.4, entryCompleteness: 0.5, completeness: 0.4, boundBy: 'curve',
    trailingAverage: 2000, accrual: 1200, estimatedTotal: 2400,
    flagged: false, flagReason: null, borrowedCurve: false,
  });

  it('round-trips a well-formed snapshot', () => {
    expect(parseLabAccrualSnapshot(good())?.accrual).toBe(1200);
  });

  it('refuses null, a non-object, and an array', () => {
    expect(parseLabAccrualSnapshot(null)).toBeNull();
    expect(parseLabAccrualSnapshot('nope')).toBeNull();
    expect(parseLabAccrualSnapshot([1, 2])).toBeNull();
  });

  it('refuses a snapshot with a missing or wrongly-typed field', () => {
    const missing = good();
    delete missing.trailingAverage;
    expect(parseLabAccrualSnapshot(missing)).toBeNull();
    expect(parseLabAccrualSnapshot({ ...good(), boundBy: 'guess' })).toBeNull();
    expect(parseLabAccrualSnapshot({ ...good(), accrual: '1200' })).toBeNull();
    expect(parseLabAccrualSnapshot({ ...good(), flagged: 'no' })).toBeNull();
  });
});
