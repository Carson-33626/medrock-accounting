import type { JournalDraft, JournalLine, Entity } from './types';
import { parseAdpDate } from './dates';
import {
  monthStart, monthEnd, monthTag, monthEndIso, nextMonthStartIso, monthEndAdp,
  shortMonthName, longMonthName, overlapsMonth, type Month,
} from './month';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const MS_PER_DAY = 86_400_000;
/** Inclusive whole-day count between two local dates. */
const inclusiveDays = (a: Date, b: Date): number => Math.round((b.getTime() - a.getTime()) / MS_PER_DAY) + 1;

/** Calendar-day ratio of a pay period that falls inside month `m`: daysInM / totalPeriodDays. */
export function dayRatioInMonth(periodStartAdp: string, periodEndAdp: string, m: Month): number {
  const start = parseAdpDate(periodStartAdp);
  const end = parseAdpDate(periodEndAdp);
  const total = inclusiveDays(start, end);
  if (total <= 0) return 0;
  const inStart = start > monthStart(m) ? start : monthStart(m);
  const inEnd = end < monthEnd(m) ? end : monthEnd(m);
  if (inEnd < inStart) return 0;
  return inclusiveDays(inStart, inEnd) / total;
}

/** A qualifying draft: its period overlaps `m` AND its pay date lands after month end. */
function qualifies(d: JournalDraft, m: Month): boolean {
  return overlapsMonth(d.periodStart, d.periodEnd, m) && parseAdpDate(d.payDate) > monthEnd(m);
}

interface AccrualBucket { accountName: string; departmentName: string | null; className: string | null; memo: string; amount: number; }

/**
 * Build the month-end accrual + its next-day reversal for ONE entity, aggregating every qualifying
 * pay-date draft for month `m`. Expense (debit) lines only — scaled by each draft's day ratio and
 * summed per (account, dept, class, memo); a single Accrued Payroll Liability credit equal to the
 * SUM OF ROUNDED debits balances it by construction. Source memos are preserved (deliberate
 * deviation from Amy — keeps the Admin/Accounting split intact). Returns null if nothing qualifies.
 */
export function buildAccrual(
  drafts: JournalDraft[], entity: Entity, m: Month,
): { accrual: JournalDraft; reversal: JournalDraft } | null {
  for (const d of drafts) {
    if (d.entity !== entity) throw new Error(`buildAccrual: draft for ${d.entity} passed for entity ${entity}`);
  }
  const qualifying = drafts.filter((d) => qualifies(d, m));
  if (qualifying.length === 0) return null;

  const suffix = ` - ${shortMonthName(m)} Accrual`;
  const buckets = new Map<string, AccrualBucket>();
  for (const d of qualifying) {
    const ratio = dayRatioInMonth(d.periodStart, d.periodEnd, m);
    if (ratio <= 0) continue;
    for (const l of d.lines) {
      if (l.postingType !== 'Debit') continue; // expense side only
      const memo = `${l.memo}${suffix}`;
      const key = [l.accountName, l.departmentName ?? '', l.className ?? '', memo].join('¦');
      let b = buckets.get(key);
      if (!b) { b = { accountName: l.accountName, departmentName: l.departmentName, className: l.className, memo, amount: 0 }; buckets.set(key, b); }
      b.amount += round2(l.amount * ratio);
    }
  }

  const debitLines: JournalLine[] = [...buckets.values()]
    .filter((b) => round2(b.amount) !== 0)
    .map((b) => ({
      postingType: 'Debit', amount: round2(b.amount), accountName: b.accountName,
      departmentName: b.departmentName, className: b.className, memo: b.memo,
      creditBucket: null, origin: 'generated', sourceRowKeys: [],
    }));
  if (debitLines.length === 0) return null;

  const total = round2(debitLines.reduce((s, l) => s + l.amount, 0));
  const creditLine: JournalLine = {
    postingType: 'Credit', amount: total, accountName: 'Accrued Payroll Liability',
    departmentName: null, className: null, memo: `Payroll Accrual - ${shortMonthName(m)}`,
    creditBucket: null, origin: 'generated', sourceRowKeys: [],
  };

  const tag = monthTag(m);
  const noteMonth = `${longMonthName(m)} ${m.year}`;
  const placeholderDates = { payDate: monthEndAdp(m), payGroup: '', periodStart: monthEndAdp(m), periodEnd: monthEndAdp(m) };

  const accrual: JournalDraft = {
    entity, kind: 'accrual', ...placeholderDates,
    docNumber: `PR Accru ${tag}`, txnDate: monthEndIso(m), privateNote: `Payroll accrual — ${noteMonth}`,
    lines: [...debitLines, creditLine], totalDebits: total, totalCredits: total, variance: 0, rowKeys: [],
  };

  const reversal: JournalDraft = {
    entity, kind: 'reversal', ...placeholderDates,
    docNumber: `PR Accru ${tag}R`, txnDate: nextMonthStartIso(m), privateNote: `Reverse of JE PR Accru ${tag}`,
    lines: accrual.lines.map((l): JournalLine => ({ ...l, postingType: l.postingType === 'Debit' ? 'Credit' : 'Debit' })),
    totalDebits: total, totalCredits: total, variance: 0, rowKeys: [],
  };

  return { accrual, reversal };
}
