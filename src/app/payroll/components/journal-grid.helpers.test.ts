import { describe, it, expect } from 'vitest';
import {
  applyAmountEdit,
  personSubtext,
  sourceNamesPreview,
  sourcePeopleTitle,
  classifyDetailColumn,
  formatDetailAmount,
  prettifyColumnLabel,
  groupSourceDetail,
  type JournalLine,
  type RosterName,
} from './journal-grid.helpers';

const baseLine: JournalLine = {
  postingType: 'Debit',
  amount: 100,
  accountName: 'Payroll Expense -:Administrative Wages',
  departmentName: null,
  className: null,
  memo: '',
  creditBucket: null,
  origin: 'manual',
  sourceRowKeys: [],
};

describe('applyAmountEdit', () => {
  it('same-side edit only changes the amount', () => {
    expect(applyAmountEdit(baseLine, 'Debit', 250)).toEqual({ amount: 250 });
  });

  it('opposite-side edit on an editable line flips the side and moves the amount', () => {
    expect(applyAmountEdit(baseLine, 'Credit', 250)).toEqual({ postingType: 'Credit', amount: 250 });
  });

  it('flips Credit → Debit for a manual credit line', () => {
    const creditLine: JournalLine = { ...baseLine, postingType: 'Credit' };
    expect(applyAmountEdit(creditLine, 'Debit', 40)).toEqual({ postingType: 'Debit', amount: 40 });
  });

  it('generated line never flips side on an opposite-side edit', () => {
    const gen: JournalLine = { ...baseLine, origin: 'generated' };
    expect(applyAmountEdit(gen, 'Credit', 250)).toEqual({});
  });

  it('generated line still accepts a same-side amount edit', () => {
    const gen: JournalLine = { ...baseLine, origin: 'generated' };
    expect(applyAmountEdit(gen, 'Debit', 250)).toEqual({ amount: 250 });
  });

  it('a zero value is a valid same-side edit', () => {
    expect(applyAmountEdit(baseLine, 'Debit', 0)).toEqual({ amount: 0 });
  });
});

describe('sourceNamesPreview', () => {
  const roster: RosterName[] = [
    { rowKey: 'a', name: 'Bob' },
    { rowKey: 'b', name: 'Jane' },
    { rowKey: 'c', name: 'Amir' },
    { rowKey: 'd', name: 'Lee' },
  ];

  it('empty source list → empty string', () => {
    expect(sourceNamesPreview([], roster)).toBe('');
  });

  it('fewer than max resolved names → comma-joined, no overflow', () => {
    expect(sourceNamesPreview(['a', 'b'], roster)).toBe('Bob, Jane');
  });

  it('more than max resolved names → first max then +N', () => {
    expect(sourceNamesPreview(['a', 'b', 'c', 'd'], roster)).toBe('Bob, Jane +2');
  });

  it('respects a custom max', () => {
    expect(sourceNamesPreview(['a', 'b', 'c'], roster, 1)).toBe('Bob +2');
  });

  it('keys that resolve to no name fall back to a people count', () => {
    expect(sourceNamesPreview(['x', 'y', 'z'], roster)).toBe('(3 people)');
  });
});

/**
 * The marketer question accounting actually asks: a Marketing cost is meaningless until you know
 * whose territory it covers (Carson, 2026-08-10).
 */
describe('personSubtext', () => {
  it('reads department, then market, then title', () => {
    expect(
      personSubtext({ department: 'Marketing', market: 'Carolina Region', title: 'Senior Territory Manager' }),
    ).toBe('Marketing · Carolina Region · Senior Territory Manager');
  });

  it('a non-marketer with no territory is just their department', () => {
    expect(personSubtext({ department: 'Lab', market: '', title: '' })).toBe('Lab');
  });

  it('drops whichever parts are missing rather than leaving separators behind', () => {
    expect(personSubtext({ department: 'Marketing', market: 'East', title: '' })).toBe('Marketing · East');
    expect(personSubtext({ department: null, market: 'East', title: 'Director' })).toBe('East · Director');
    expect(personSubtext({})).toBe('');
  });

  it('does NOT include location — that is where the dollars post, not who the person is', () => {
    // personContext carries location; the two are deliberately different.
    expect(personSubtext({ department: 'Marketing', market: 'Carolina Region' })).not.toContain('Dallas');
  });
});

/**
 * The Name cell can show two names; the tooltip is where "which Marketing people, covering which
 * markets, add up to this line?" gets answered. Carson, 2026-08-06 and 2026-08-10.
 */
describe('sourcePeopleTitle', () => {
  const roster: RosterName[] = [
    { rowKey: 'a', name: 'Bob', department: 'Marketing', market: 'Carolina Region' },
    { rowKey: 'b', name: 'Amir', department: 'Marketing', market: 'Gulf Region' },
    { rowKey: 'c', name: 'Lee' }, // nothing on file
  ];

  it('empty source list → empty string', () => {
    expect(sourcePeopleTitle([], roster)).toBe('');
  });

  it('one line per person, "Name — Dept · Market", alphabetical', () => {
    expect(sourcePeopleTitle(['a', 'b'], roster)).toBe(
      'Amir — Marketing · Gulf Region\nBob — Marketing · Carolina Region',
    );
  });

  it('a person with no department or market is listed by name alone', () => {
    expect(sourcePeopleTitle(['c'], roster)).toBe('Lee');
  });

  it('lists every person, unlike the two-name preview', () => {
    expect(sourcePeopleTitle(['a', 'b', 'c'], roster).split('\n')).toHaveLength(3);
  });

  it('wholly unresolved keys degrade to a count instead of a misleading partial list', () => {
    expect(sourcePeopleTitle(['x', 'y'], roster)).toBe('2 people (names not loaded)');
  });

  it('a PARTIALLY resolved roster says how many people it could not name', () => {
    expect(sourcePeopleTitle(['a', 'x', 'y'], roster)).toBe(
      'Bob — Marketing · Carolina Region\n+2 more (names not loaded)',
    );
  });

  it("NEVER shows ADP's `location` — it is the entity code, which the run already states", () => {
    const withLocation: RosterName[] = [
      { rowKey: 'z', name: 'Bob', department: 'Marketing', location: 'MEDFL-MedRock FL', market: 'Miami Region' },
    ];
    const out = sourcePeopleTitle(['z'], withLocation);
    expect(out).toBe('Bob — Marketing · Miami Region');
    expect(out).not.toContain('MEDFL');
  });
});

describe('classifyDetailColumn', () => {
  it('maps earning columns to Earnings/usd', () => {
    expect(classifyDetailColumn('REGULAR PAY - EARNING')).toEqual({ group: 'Earnings', unit: 'usd' });
    expect(classifyDetailColumn('CAR ALLOWANCE - EARNING')).toEqual({ group: 'Earnings', unit: 'usd' });
  });
  it('maps EE deductions/taxes to Employee/usd', () => {
    expect(classifyDetailColumn('SOCIAL SECURITY - EE')).toEqual({ group: 'Employee deductions & taxes', unit: 'usd' });
    expect(classifyDetailColumn('FEDERAL - EE INCOME TAX')).toEqual({ group: 'Employee deductions & taxes', unit: 'usd' });
    expect(classifyDetailColumn('NET PAY')).toEqual({ group: 'Employee deductions & taxes', unit: 'usd' });
  });
  it('maps ER costs to Employer/usd and NOT earnings/EE', () => {
    expect(classifyDetailColumn('MEDICAL - ER')).toEqual({ group: 'Employer costs', unit: 'usd' });
    expect(classifyDetailColumn('SOCIAL SECURITY - ER')).toEqual({ group: 'Employer costs', unit: 'usd' });
  });
  it('maps hours to Hours & rate/hours and rate to Hours & rate/usd', () => {
    expect(classifyDetailColumn('REGULAR PAY - HOURS')).toEqual({ group: 'Hours & rate', unit: 'hours' });
    expect(classifyDetailColumn('RATE AMOUNT')).toEqual({ group: 'Hours & rate', unit: 'usd' });
  });
  it('drops derived/reference columns (returns null)', () => {
    expect(classifyDetailColumn('TOTAL HOURS')).toBeNull();
    expect(classifyDetailColumn('GROSS PAY')).toBeNull();
    expect(classifyDetailColumn('REGULAR PAY EARNINGS - TOTAL')).toBeNull();
    expect(classifyDetailColumn('MEDICARE - EE TAXABLE')).toBeNull();
    expect(classifyDetailColumn('SOCIAL SECURITY - EE TAXABLE')).toBeNull();
  });
});

describe('formatDetailAmount', () => {
  it('formats usd as currency', () => {
    expect(formatDetailAmount(2500, 'usd')).toBe('$2,500.00');
    expect(formatDetailAmount(276.92, 'usd')).toBe('$276.92');
  });
  it('formats hours with an hrs suffix, no currency', () => {
    expect(formatDetailAmount(80, 'hours')).toBe('80.00 hrs');
    expect(formatDetailAmount(80.25, 'hours')).toBe('80.25 hrs');
  });
});

describe('prettifyColumnLabel', () => {
  it('strips the trailing - EARNING for the Earnings group and title-cases', () => {
    expect(prettifyColumnLabel('REGULAR PAY - EARNING', 'Earnings')).toBe('Regular Pay');
    expect(prettifyColumnLabel('CAR ALLOWANCE - EARNING', 'Earnings')).toBe('Car Allowance');
  });
  it('keeps EE/ER acronyms uppercase', () => {
    expect(prettifyColumnLabel('SOCIAL SECURITY - EE', 'Employee deductions & taxes')).toBe('Social Security - EE');
    expect(prettifyColumnLabel('MEDICAL - ER', 'Employer costs')).toBe('Medical - ER');
  });
  it('title-cases hyphen parts (PRE-TAX -> Pre-Tax)', () => {
    expect(prettifyColumnLabel('MEDICAL - EE PRE-TAX', 'Employee deductions & taxes')).toBe('Medical - EE Pre-Tax');
  });
});

describe('groupSourceDetail', () => {
  const sensitive = {
    'REGULAR PAY - EARNING': 2500,
    'CAR ALLOWANCE - EARNING': 276.92,
    'SOCIAL SECURITY - EE': 179.73,
    'NET PAY': 2379,
    'MEDICAL - ER': 128,
    'REGULAR PAY - HOURS': 80,
    'RATE AMOUNT': 2500,
    'GROSS PAY': 3026.92, // derived -> dropped
    'TOTAL HOURS': 80, // derived -> dropped
    'MEDICARE - EE TAXABLE': 2898.92, // taxable base -> dropped
    'SOME CODE': 'ABC', // string -> excluded
    'ZERO COL': 0, // zero -> excluded
  };

  it('returns ordered, non-empty sections with derived/zero/string columns excluded', () => {
    const sections = groupSourceDetail(sensitive);
    expect(sections.map((s) => s.group)).toEqual([
      'Earnings',
      'Employee deductions & taxes',
      'Employer costs',
      'Hours & rate',
    ]);
    const flat = sections.flatMap((s) => s.rows.map((r) => r.label));
    expect(flat).not.toContain('Gross Pay');
    expect(flat.some((l) => /Total/i.test(l))).toBe(false);
    expect(flat.some((l) => /Taxable/i.test(l))).toBe(false);
  });

  it('formats hours as hrs and dollars as currency, sorted by descending amount within a group', () => {
    const sections = groupSourceDetail(sensitive);
    const earnings = sections.find((s) => s.group === 'Earnings');
    expect(earnings?.rows.map((r) => r.display)).toEqual(['$2,500.00', '$276.92']);
    const hours = sections.find((s) => s.group === 'Hours & rate');
    const hoursRow = hours?.rows.find((r) => r.unit === 'hours');
    expect(hoursRow?.display).toBe('80.00 hrs');
  });
});
