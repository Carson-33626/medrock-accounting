// Pure month-split engine for straddling pay periods (spec 2026-07-27). buildJournal's
// output is transformed AFTER the penny-validated build: one piece per calendar month the
// period overlaps, every line prorated by calendar-day ratio with largest-remainder
// settling per line, then a balance repair on the largest credit line so each piece is
// internally balanced AND every line re-sums to its original to the penny.
import type { JournalDraft, JournalLine } from './types';
import { parseAdpDate } from './dates';
import { dayRatioInMonth } from './accrual';
import { monthEndIso, shortMonthName, type Month } from './month';
import { docNumber, txnDate } from './qb-journal';

const pad2 = (n: number): string => String(n).padStart(2, '0');

export const segmentTag = (m: Month): string => `${m.year}-${pad2(m.month)}`;

/** 'Jun' for '2026-06' — badge/tab label. Falls back to the raw tag on a malformed segment. */
export function pieceLabel(segment: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(segment);
  if (!match) return segment;
  return shortMonthName({ year: Number(match[1]), month: Number(match[2]) });
}

/** Every calendar month the (inclusive) period overlaps, in chronological order. */
export function segmentsForPeriod(periodStartAdp: string, periodEndAdp: string): Month[] {
  const start = parseAdpDate(periodStartAdp);
  const end = parseAdpDate(periodEndAdp);
  const out: Month[] = [];
  let y = start.getFullYear();
  let mo = start.getMonth() + 1;
  while (y < end.getFullYear() || (y === end.getFullYear() && mo <= end.getMonth() + 1)) {
    out.push({ year: y, month: mo });
    if (mo === 12) { y += 1; mo = 1; } else { mo += 1; }
  }
  return out;
}

/**
 * Largest-remainder split of an integer cent amount across ratios. Re-sums exactly by
 * construction; ties break to the earliest segment (deterministic).
 */
export function allocateCents(totalCents: number, ratios: number[]): number[] {
  const raw = ratios.map((r) => totalCents * r);
  const base = raw.map((x) => Math.floor(x));
  let leftover = totalCents - base.reduce((s, x) => s + x, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (leftover <= 0) break;
    base[i] += 1;
    leftover -= 1;
  }
  return base;
}

/** `PR YYYY.MM.DD` + chronological letter suffix when the run is split. */
export function pieceDocNumber(payDateAdp: string, segmentCount: number, segmentIndex: number): string {
  const stem = docNumber(payDateAdp);
  if (segmentCount <= 1) return stem;
  return `${stem}${String.fromCharCode(65 + segmentIndex)}`; // A, B, C…
}

/** Pay-date month → the pay date itself; any other month → that month's last day. */
export function pieceTxnDate(payDateAdp: string, m: Month): string {
  const pd = parseAdpDate(payDateAdp);
  if (pd.getFullYear() === m.year && pd.getMonth() + 1 === m.month) return txnDate(payDateAdp);
  return monthEndIso(m);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Split one built draft into per-month sibling drafts. Non-straddlers, unbalanced drafts
 * (mid-review state), and impossible repairs all return `[draft]` UNCHANGED (byte-identical).
 * Throws only if a balanced straddler's balance repair would corrupt the credit line.
 */
export function splitStraddle(draft: JournalDraft): JournalDraft[] {
  if (!draft.periodStart || !draft.periodEnd) return [draft];
  const segments = segmentsForPeriod(draft.periodStart, draft.periodEnd);
  if (segments.length <= 1) return [draft];

  // An unbalanced draft (unmapped columns, mid-review state) cannot be split-and-repaired
  // cleanly. Leave it whole on its pay date — it is not postable while unbalanced, and the
  // reconcile rebuild path re-splits it automatically once mapping fixes balance it.
  if (Math.round(draft.variance * 100) !== 0) return [draft];

  const ratios = segments.map((m) => dayRatioInMonth(draft.periodStart, draft.periodEnd, m));

  // Per-line cent allocation: alloc[lineIdx][segIdx].
  const alloc: number[][] = draft.lines.map((l) => allocateCents(Math.round(l.amount * 100), ratios));

  // Balance repair. Per-line largest remainder does NOT guarantee each piece balances
  // (several small debits can all round into the same month). The original draft balances,
  // so piece imbalances sum to zero — shift whole cents of the LARGEST credit line
  // (Net Pay in practice) between pieces to zero each one. Preserves that line's re-sum.
  const imbalance = segments.map((_, s) =>
    draft.lines.reduce((sum, l, i) => sum + (l.postingType === 'Debit' ? alloc[i][s] : -alloc[i][s]), 0),
  );
  if (imbalance.some((x) => x !== 0)) {
    let repairIdx = -1;
    let repairMax = -1;
    for (let i = 0; i < draft.lines.length; i++) {
      if (draft.lines[i].postingType === 'Credit' && draft.lines[i].amount > repairMax) {
        repairMax = draft.lines[i].amount;
        repairIdx = i;
      }
    }
    if (repairIdx < 0) throw new Error('splitStraddle: no credit line available for balance repair');
    for (let s = 0; s < segments.length; s++) {
      // imbalance[s] > 0 → piece has excess debit → it needs MORE of the credit line.
      alloc[repairIdx][s] += imbalance[s];
      if (alloc[repairIdx][s] < 0) {
        throw new Error('splitStraddle: balance repair would make the credit line negative');
      }
    }
  }

  const payMonthTag = segmentTag({
    year: parseAdpDate(draft.payDate).getFullYear(),
    month: parseAdpDate(draft.payDate).getMonth() + 1,
  });

  return segments.map((m, s): JournalDraft => {
    const tag = segmentTag(m);
    const suffix = tag === payMonthTag ? '' : ` - ${shortMonthName(m)} portion`;
    const lines: JournalLine[] = [];
    for (let i = 0; i < draft.lines.length; i++) {
      const cents = alloc[i][s];
      if (cents === 0) continue; // zero-amount lines are dropped from this piece
      lines.push({ ...draft.lines[i], amount: cents / 100, memo: `${draft.lines[i].memo}${suffix}` });
    }
    const totalDebits = round2(lines.filter((l) => l.postingType === 'Debit').reduce((x, l) => x + l.amount, 0));
    const totalCredits = round2(lines.filter((l) => l.postingType === 'Credit').reduce((x, l) => x + l.amount, 0));
    return {
      ...draft,
      kind: 'pay_date',
      periodSegment: tag,
      docNumber: pieceDocNumber(draft.payDate, segments.length, s),
      txnDate: pieceTxnDate(draft.payDate, m),
      privateNote: `Split ${s + 1}/${segments.length} of ${docNumber(draft.payDate)} — period ${draft.periodStart}–${draft.periodEnd}`,
      lines,
      totalDebits,
      totalCredits,
      variance: round2(totalDebits - totalCredits),
    };
  });
}
