import { describe, it, expect } from 'vitest';
import {
  normalizeItem, recordHistory, classifyLine, planMediscaEnrichment, MIN_CONFIDENCE,
} from './medisca-gl';
import type { MediscaHistory, MediscaDraftLine } from './medisca-gl';

function historyOf(entries: [string, string][]): MediscaHistory {
  const h: MediscaHistory = new Map();
  for (const [desc, acct] of entries) recordHistory(h, desc, acct);
  return h;
}

// Real strings from her QuickBooks lines and from Ramp's drafts (2026-08-04).
const ASCORBIC_QB = 'Ascorbic Acid USP/EP (Dietary Supplement Grade):227724/A Exp:01/31/30 Qty:5';
const ITRACONAZOLE_RAMP = 'Itraconazole, USP Lot:233113/E Exp:11/30/29';

describe('normalizeItem', () => {
  it('truncates the QB lot/expiry/qty tail', () => {
    expect(normalizeItem(ASCORBIC_QB)).toBe('ascorbic acid usp ep dietary supplement grade');
  });

  it('leaves no dangling "lot" token — the bug that cost 8 real matches', () => {
    // Stripping ":233113/E Exp:..." on its own would leave "itraconazole usp lot", which never
    // matches the QB side's "itraconazole usp".
    expect(normalizeItem(ITRACONAZOLE_RAMP)).toBe('itraconazole usp');
  });

  it('makes the QB and Ramp spellings of one item collide', () => {
    expect(normalizeItem('Itraconazole, USP')).toBe(normalizeItem(ITRACONAZOLE_RAMP));
  });
});

describe('classifyLine', () => {
  const history = historyOf([
    ...Array<[string, string]>(9).fill(['Ascorbic Acid USP', '1220.10']),
    ['Weigh Boat, Anti-Static, 3.5 x 3.5 x 1", Medium, Black', '1220.20'],
    ...Array<[string, string]>(6).fill(['Tranexamic Acid, USP', '1220.10']),
    ['Tranexamic Acid, USP', '1220.05'],
    ...Array<[string, string]>(14).fill(['Mixer, Samix ES500', '1500.02']),
  ]);

  it('codes freight from wording alone, without needing history', () => {
    expect(classifyLine('Hazmat Shipping Fee', history).account).toBe('5000.45');
    expect(classifyLine('FREIGHT CHARGE', history).account).toBe('5000.45');
  });

  it('replays an item she has coded consistently', () => {
    const v = classifyLine('Ascorbic Acid USP', history);
    expect(v.account).toBe('1220.10');
    expect(v.reason).toContain('history(9/9)');
  });

  it('matches a Ramp memo that is a shortened form of her description', () => {
    // Ramp drops the leading "Weigh"; containment recovers it because only one account is in play.
    const v = classifyLine('Boat, Anti-Static, 3.5 x 3.5 x 1", Medium, Black', history);
    expect(v.account).toBe('1220.20');
    expect(v.reason).toContain('fuzzy');
  });

  it('REFUSES an item she has coded inconsistently, rather than taking the majority', () => {
    // 6 of 7 = 85.7%, under the gate. This is a real case from her books.
    const v = classifyLine('Tranexamic Acid, USP', history);
    expect(v.account).toBeNull();
    expect(v.reason).toContain('ambiguous');
  });

  it('refuses an item she has never coded', () => {
    expect(classifyLine('Bimatoprost (Frozen)', history).account).toBeNull();
    expect(classifyLine('Bimatoprost (Frozen)', history).reason).toBe('no_history');
  });

  it('refuses an empty memo instead of defaulting it', () => {
    expect(classifyLine('', history).reason).toBe('empty_memo');
  });

  it('will replay a capital-equipment account only on her own consistent history', () => {
    // 1500.02 is never GUESSED — but if she has coded this exact mixer 14/14 times, replaying it
    // is reproducing her decision, not making one.
    expect(classifyLine('Mixer, Samix ES500', history).account).toBe('1500.02');
  });

  it('applies the confidence gate at exactly MIN_CONFIDENCE', () => {
    const h = historyOf([
      ...Array<[string, string]>(9).fill(['Widget', '1220.10']),
      ['Widget', '1220.20'],
    ]);
    expect(9 / 10).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(classifyLine('Widget', h).account).toBe('1220.10');
  });
});

describe('planMediscaEnrichment', () => {
  const history = historyOf([
    ...Array<[string, string]>(9).fill(['Ascorbic Acid USP', '1220.10']),
    ...Array<[string, string]>(6).fill(['Tranexamic Acid, USP', '1220.10']),
    ['Tranexamic Acid, USP', '1220.05'],
  ]);
  const good: MediscaDraftLine[] = [
    { amountCents: 12000, memo: 'Ascorbic Acid USP', coded: false },
    { amountCents: 1500, memo: 'Shipping & handling', coded: false },
  ];

  it('codes every line when all of them classify', () => {
    const plan = planMediscaEnrichment(good, history);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.map((l) => l.account)).toEqual(['1220.10', '5000.45']);
  });

  it('preserves her amounts and memos verbatim — PATCH replaces the whole array', () => {
    const plan = planMediscaEnrichment(good, history);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.map((l) => l.amountCents)).toEqual([12000, 1500]);
    expect(plan.lines.map((l) => l.memo)).toEqual(['Ascorbic Acid USP', 'Shipping & handling']);
  });

  it('refuses the WHOLE draft when a single line is unclassifiable', () => {
    const mixed: MediscaDraftLine[] = [
      { amountCents: 12000, memo: 'Ascorbic Acid USP', coded: false },
      { amountCents: 900, memo: 'Tranexamic Acid, USP', coded: false },
    ];
    const plan = planMediscaEnrichment(mixed, history);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('unclassifiable');
    expect(plan.detail).toContain('Tranexamic');
  });

  it('refuses a draft she has already started coding', () => {
    const plan = planMediscaEnrichment(
      [{ amountCents: 12000, memo: 'Ascorbic Acid USP', coded: true }],
      history,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('already_coded');
  });

  it('refuses an empty draft rather than patching it to nothing', () => {
    const plan = planMediscaEnrichment([], history);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('no_lines');
  });

  it('keeps the coded total equal to the draft total', () => {
    const plan = planMediscaEnrichment(good, history);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.reduce((a, l) => a + l.amountCents, 0)).toBe(13500);
  });
});
