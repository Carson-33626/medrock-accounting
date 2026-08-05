import { describe, it, expect } from 'vitest';
import {
  normalizeItem, recordHistory, classifyLine, planMediscaEnrichment, MIN_CONFIDENCE,
} from './medisca-gl';
import type { MediscaHistory, MediscaDraftLine } from './medisca-gl';
import { buildRulings, ITEM_RULINGS, LINE_RULINGS } from './medisca-rulings';

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

describe('human rulings', () => {
  const rulings = buildRulings();

  // 7x 1220.10 / 1x 1220.05 = 87.5% — the real history that blocked three drafts.
  const ambiguous = historyOf([
    ...Array<[string, string]>(7).fill(['Tranexamic Acid, USP', '1220.10']),
    ['Tranexamic Acid, USP', '1220.05'],
  ]);

  it('resolves an item history refuses as ambiguous', () => {
    expect(classifyLine('Tranexamic Acid, USP', ambiguous).account).toBeNull();
    const plan = planMediscaEnrichment(
      [{ amountCents: 246300, memo: 'Tranexamic Acid, USP', coded: false }],
      ambiguous,
      { rulings },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].account).toBe('1220.10');
    expect(plan.lines[0].reason).toBe('item_ruling');
  });

  it('NEVER overrides her own confident history', () => {
    // She has since coded this item 1220.05 consistently. Her practice must win over the standing
    // ruling, otherwise a ruling silently freezes the books at the day it was made.
    const changed = historyOf(Array<[string, string]>(10).fill(['Tranexamic Acid, USP', '1220.05']));
    const plan = planMediscaEnrichment(
      [{ amountCents: 246300, memo: 'Tranexamic Acid, USP', coded: false }],
      changed,
      { rulings },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].account).toBe('1220.05');
    expect(plan.lines[0].reason).toContain('history');
  });

  it('matches a ruling through normalisation, not exact text', () => {
    // The Ramp memo carries a lot/qty tail the ruling's sample does not.
    const plan = planMediscaEnrichment(
      [{ amountCents: 5200, memo: 'Stir-Bar Positioner/Retriever 12" Lot:228149/A Exp:N/A Qty:2', coded: false }],
      new Map(),
      { rulings },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0].account).toBe('1220.20');
  });

  it('codes the memo-less glove line by draft position', () => {
    const lines: MediscaDraftLine[] = [
      { amountCents: 6000, memo: 'Gloves, Blue Nitrile Powder-Free, (S - 9"- 4 mil)', coded: false },
      { amountCents: 6000, memo: 'Gloves, Blue Nitrile Powder-Free, (M - 9"- 4 mil)', coded: false },
      { amountCents: 6000, memo: '', coded: false },
    ];
    const gloves = historyOf([
      ['Gloves, Blue Nitrile Powder-Free, (S - 9"- 4 mil)', '1220.20'],
      ['Gloves, Blue Nitrile Powder-Free, (M - 9"- 4 mil)', '1220.20'],
    ]);
    const plan = planMediscaEnrichment(lines, gloves, { rulings, draftId: LINE_RULINGS[0].draftId });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.map((l) => l.account)).toEqual(['1220.20', '1220.20', '1220.20']);
    expect(plan.lines[2].reason).toBe('line_ruling');
  });

  it('drops a line ruling when the amount no longer matches — the draft moved under us', () => {
    const plan = planMediscaEnrichment(
      [
        { amountCents: 6000, memo: 'Gloves, Blue Nitrile Powder-Free, (S - 9"- 4 mil)', coded: false },
        { amountCents: 6000, memo: 'Gloves, Blue Nitrile Powder-Free, (M - 9"- 4 mil)', coded: false },
        { amountCents: 9900, memo: '', coded: false },
      ],
      historyOf([
        ['Gloves, Blue Nitrile Powder-Free, (S - 9"- 4 mil)', '1220.20'],
        ['Gloves, Blue Nitrile Powder-Free, (M - 9"- 4 mil)', '1220.20'],
      ]),
      { rulings, draftId: LINE_RULINGS[0].draftId },
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('unclassifiable');
  });

  it('does not apply a line ruling to a different draft', () => {
    const plan = planMediscaEnrichment(
      [{ amountCents: 6000, memo: '', coded: false }],
      new Map(),
      { rulings, draftId: 'some-other-draft' },
    );
    expect(plan.ok).toBe(false);
  });

  it('still refuses an unruled, unknown item', () => {
    const plan = planMediscaEnrichment(
      [{ amountCents: 1000, memo: 'Something She Has Never Bought', coded: false }],
      new Map(),
      { rulings },
    );
    expect(plan.ok).toBe(false);
  });

  it('rules no item into a capitalisation account', () => {
    // 1500.02 (Fixed Assets) and 8220 (Suspense) are judgement calls that stay hers by construction.
    for (const r of ITEM_RULINGS) expect(['1500.02', '8220']).not.toContain(r.account);
    for (const r of LINE_RULINGS) expect(['1500.02', '8220']).not.toContain(r.account);
  });

  it('rejects two rulings that disagree on the same item', () => {
    expect(() => buildRulings([
      { sample: 'Widget', account: '1220.10', rationale: 'a' },
      { sample: 'Widget', account: '1220.20', rationale: 'b' },
    ], [])).toThrow(/Conflicting/);
  });
});
