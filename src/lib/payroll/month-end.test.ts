import { describe, it, expect } from 'vitest';
import { buildMonthEndAllocation, eomDocNumber, eomPrivateNote } from './month-end';
import type { EomEntity } from './revenue-rule';
import type { PoolLine } from './qb-pool';
import type { Entity, JournalDraft } from './types';

const M = { year: 2026, month: 3 };
const THIRDS: Record<EomEntity, number> = { 'MedRock FL': 100 / 3, 'MedRock TN': 100 / 3, 'MedRock TX': 100 / 3 };
const FL_TN: Record<EomEntity, number> = { 'MedRock FL': 50, 'MedRock TN': 50, 'MedRock TX': 0 };

const pl = (entity: Entity, account: string, amount: number, rule: PoolLine['rule'], counterparty: Entity | null = null): PoolLine => ({
  entity, txnType: 'JournalEntry', txnId: '1', txnDate: '2026-03-15', docNumber: null,
  accountName: account, className: null, departmentName: '% Allocation', memo: null, amount, rule, counterparty,
});

const total = (d: JournalDraft, side: 'Debit' | 'Credit'): number =>
  Math.round(d.lines.filter((l) => l.postingType === side).reduce((s, l) => s + l.amount, 0) * 100) / 100;

describe('buildMonthEndAllocation', () => {
  it('revenue-rule pool in FL splits to TN and TX; all drafts balance; sheds equal pickups', () => {
    const drafts = buildMonthEndAllocation([pl('MedRock FL', 'Payroll Expense -:Administrative Wages', 9000, 'revenue')], THIRDS, M);
    expect(drafts).toHaveLength(3);
    for (const d of drafts) {
      expect(d.variance).toBe(0);
      expect(d.kind).toBe('allocation');
      expect(d.payGroup).toBe('EOM');
      expect(d.payDate).toBe('03/31/2026');
      expect(d.txnDate).toBe('2026-03-31');
      for (const l of d.lines) { expect(l.departmentName).toBeNull(); expect(l.className).toBeNull(); }
    }
    const fl = drafts.find((d) => d.entity === 'MedRock FL') as JournalDraft;
    const tn = drafts.find((d) => d.entity === 'MedRock TN') as JournalDraft;
    const tx = drafts.find((d) => d.entity === 'MedRock TX') as JournalDraft;
    // FL sheds 2/3 of 9000 = 6000: credit wages 6000, debit Due-from TN 3000 + Due-from TX 3000
    expect(total(fl, 'Credit')).toBe(6000);
    expect(fl.lines.some((l) => l.accountName === 'Due from MedRock TN, LLC' && l.postingType === 'Debit' && l.amount === 3000)).toBe(true);
    expect(tn.lines.some((l) => l.accountName === 'Payroll Expense -:Administrative Wages' && l.postingType === 'Debit' && l.amount === 3000)).toBe(true);
    expect(tn.lines.some((l) => l.accountName === 'Due to Medrock Pharmacy, LLC' && l.postingType === 'Credit' && l.amount === 3000)).toBe(true);
    expect(total(tx, 'Debit')).toBe(3000);
  });

  it('penny torture: 1-cent and 2-cent pools stay exact', () => {
    const drafts = buildMonthEndAllocation(
      [pl('MedRock FL', 'A', 0.01, 'revenue'), pl('MedRock FL', 'B', 0.02, 'revenue')], THIRDS, M);
    const all = drafts.flatMap((d) => d.lines);
    const cents = (n: number): number => Math.round(n * 100);
    // Cross-draft symmetry: signed IE cents across ALL drafts must net to exactly zero
    // (every cent one company is owed, another owes).
    const ieNet = all
      .filter((l) => l.accountName.startsWith('Due'))
      .reduce((s, l) => s + cents(l.amount) * (l.postingType === 'Debit' ? 1 : -1), 0);
    expect(ieNet).toBe(0);
    // And the 3 cents of pool actually moved somewhere: total expense cents debited at
    // receivers equals total credited at sources.
    const expenseCents = all.filter((l) => !l.accountName.startsWith('Due'));
    const recv = expenseCents.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + cents(l.amount), 0);
    const shed = expenseCents.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + cents(l.amount), 0);
    expect(recv).toBe(shed);
    expect(recv).toBeGreaterThan(0);
    for (const d of drafts) expect(d.variance).toBe(0);
  });

  it('thirds rule splits 1/3 regardless of revenue shares', () => {
    const drafts = buildMonthEndAllocation([pl('MedRock TN', 'G&A -:Dues', 300, 'thirds')], FL_TN, M);
    const tx = drafts.find((d) => d.entity === 'MedRock TX') as JournalDraft;
    expect(tx.lines.some((l) => l.accountName === 'G&A -:Dues' && l.postingType === 'Debit' && l.amount === 100)).toBe(true);
  });

  it('fifty rule splits only between holder and counterparty', () => {
    const drafts = buildMonthEndAllocation([pl('MedRock FL', 'G&A -:Rent', 500, 'fifty', 'MedRock TN')], THIRDS, M);
    expect(drafts.find((d) => d.entity === 'MedRock TX')).toBeUndefined();
    const tn = drafts.find((d) => d.entity === 'MedRock TN') as JournalDraft;
    expect(tn.lines.some((l) => l.amount === 250 && l.postingType === 'Debit')).toBe(true);
  });

  it('negative net group (refund) allocates with flipped sides', () => {
    const drafts = buildMonthEndAllocation([pl('MedRock FL', 'G&A -:Software', -300, 'thirds')], THIRDS, M);
    const fl = drafts.find((d) => d.entity === 'MedRock FL') as JournalDraft;
    // FL sheds a NEGATIVE cost: debit the account back, credit Due-froms
    expect(fl.lines.some((l) => l.accountName === 'G&A -:Software' && l.postingType === 'Debit' && l.amount === 200)).toBe(true);
    for (const d of drafts) expect(d.variance).toBe(0);
  });

  it('entity with a zero-revenue share receives nothing under the revenue rule', () => {
    const drafts = buildMonthEndAllocation([pl('MedRock FL', 'Wages', 1000, 'revenue')], FL_TN, M);
    expect(drafts.find((d) => d.entity === 'MedRock TX')).toBeUndefined();
    const tn = drafts.find((d) => d.entity === 'MedRock TN') as JournalDraft;
    expect(tn.lines.some((l) => l.amount === 500)).toBe(true);
  });

  it('empty pool -> no drafts', () => {
    expect(buildMonthEndAllocation([], THIRDS, M)).toHaveLength(0);
  });

  it('doc number and note formats', () => {
    expect(eomDocNumber('MedRock TX', M)).toBe('TX % Allo 2026.03');
    expect(eomPrivateNote(THIRDS, M)).toContain('March 2026');
    expect(eomPrivateNote(THIRDS, M)).toContain('FL 33.33%');
  });
});
