/**
 * The ADP source detail behind a posted payroll (`pay_date`) journal entry, shaped as an
 * extra sheet of the entry's own workbook.
 *
 * PRIVACY (DS §8 open question 3, decided conservatively here): this sheet is
 * DEPARTMENT/CLASS grain and carries no employee names, position ids or per-person
 * amounts — only a headcount. QuickBooks attachments are visible to everyone with company
 * access, and payroll detail is employee-level, so the file deliberately stops at the same
 * grain as the entry it accompanies: the posted JE line is already
 * `<bucket> - <Department>`, and this sheet only splits that line into the ADP columns that
 * fed it. Names stay behind the existing decrypt gate on the drill-down.
 *
 * FOOTING IS THE CONTRACT. The sheet's Debit/Credit totals equal the entry's, and every
 * line's rows sum to that line, or the builder returns NOTHING. A detail file that does not
 * add up is worse than no attachment because it looks authoritative (DS §7 acceptance 2), so
 * a mismatch between the stored draft and a fresh build degrades to no sheet rather than to
 * an approximate one.
 */
import type { CellValue, ExportColumn } from '@/lib/inventory-export';
import type { JournalLine } from './types';
import type { LineSourceDetail } from './build-je';
import type { DetailSheet } from '@/lib/inventory/je-detail';

const COLUMNS: ExportColumn[] = [
  { header: 'Type', key: 'type' },
  { header: 'Account', key: 'account' },
  { header: 'Memo', key: 'memo' },
  { header: 'Department', key: 'department' },
  { header: 'Class', key: 'className' },
  { header: 'ADP Column', key: 'adpColumn' },
  { header: 'Employees', key: 'employees' },
  { header: 'Debit', key: 'debit', currency: true },
  { header: 'Credit', key: 'credit', currency: true },
];

/** Lines an accountant typed or an inter-entity companion added have no ADP column behind them. */
const NO_SOURCE = '(hand-entered — no ADP source)';

export interface PayrollDetailInput {
  /** The lines as PERSISTED on the header being posted (a split piece carries only its month). */
  storedLines: readonly JournalLine[];
  /** A fresh `buildJournal` over the same run's source rows — the WHOLE run, unsplit. */
  rebuiltLines: readonly JournalLine[];
  /** `buildJournal`'s per-line ADP-column composition, index-aligned with `rebuiltLines`. */
  rebuiltSources: readonly LineSourceDetail[][];
  /**
   * The suffix `splitStraddle` appended to this piece's memos (' - Jun portion'), or '' for
   * an unsplit run. Stripped before matching, because the rebuild is of the whole run and
   * knows nothing about the piece.
   */
  memoSuffix: string;
  /** One-line banner: entity, pay group, pay date, doc number. */
  label: string;
}

interface Group {
  postingType: JournalLine['postingType'];
  accountName: string;
  departmentName: string | null;
  className: string | null;
  creditBucket: JournalLine['creditBucket'];
  memo: string;
  cents: number;
  columns: Map<string, { cents: number; employees: number }>;
}

const groupKey = (l: JournalLine, memo: string): string =>
  [l.accountName, l.departmentName ?? '', l.className ?? '', l.creditBucket ?? '', l.postingType, memo].join('¦');

/**
 * The same line WITHOUT its department/class tag.
 *
 * Department and class are the allocation OVERLAY (`% Allocation` / `Allocate - %`), applied on
 * top of a bucket the memo already names — `ER Medical - CSR` says which cost centre the
 * dollars came from whether or not the pool tag is on the line. When the overlay rules change
 * the tag moves without a single dollar or ADP column moving with it: the CS revenue-split
 * classes arrived 2026-08-25 and re-tagged 19 of the 100 lines on FL's 08/14 run, which are
 * otherwise identical to what posted.
 *
 * So this is the fallback key, used ONLY where it identifies exactly one group on each side.
 * Ambiguity means buckets genuinely merged or split, and then the column mix behind a line is
 * no longer knowable — at which point the builder ships nothing.
 */
const relaxedKey = (l: JournalLine, memo: string): string =>
  [l.accountName, l.creditBucket ?? '', l.postingType, memo].join('¦');

/**
 * Distribute `targetCents` across `parts` in proportion to what they hold, exactly.
 *
 * A split piece is a calendar-day proration of the whole run, so its line is a fraction of
 * the rebuilt one; the columns behind it have to be prorated the same way or the rows will
 * not sum to the line. Largest-remainder, with the leftover on the biggest part — the same
 * settle `build-je` and `splitStraddle` already use, so the three agree.
 */
function prorate(targetCents: number, parts: readonly number[]): number[] {
  const total = parts.reduce((s, p) => s + p, 0);
  if (total === 0) return parts.map(() => 0);
  const raw = parts.map((p) => (p * targetCents) / total);
  const out = raw.map((x) => Math.trunc(x));
  let leftover = targetCents - out.reduce((s, x) => s + x, 0);
  const order = raw
    .map((x, i) => ({ i, frac: Math.abs(x - Math.trunc(x)) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const step = leftover >= 0 ? 1 : -1;
  for (const { i } of order) {
    if (leftover === 0) break;
    out[i] += step;
    leftover -= step;
  }
  // More leftover than parts (only reachable on a pathological input): dump the rest on the
  // largest part rather than silently losing it.
  if (leftover !== 0) {
    let largest = 0;
    for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[largest])) largest = i;
    out[largest] += leftover;
  }
  return out;
}

/** A group's identity fields as a line, so one key function serves both sides. */
const asLine = (g: Group): JournalLine => ({
  postingType: g.postingType,
  amount: 0,
  accountName: g.accountName,
  departmentName: g.departmentName,
  className: g.className,
  memo: g.memo,
  creditBucket: g.creditBucket,
  origin: 'generated',
  sourceRowKeys: [],
});

function collapse(
  lines: readonly JournalLine[],
  memoOf: (l: JournalLine) => string,
  sourcesOf: (i: number) => readonly LineSourceDetail[],
): Map<string, Group> {
  const out = new Map<string, Group>();
  lines.forEach((l, i) => {
    const memo = memoOf(l);
    const key = groupKey(l, memo);
    let g = out.get(key);
    if (!g) {
      g = {
        postingType: l.postingType,
        accountName: l.accountName,
        departmentName: l.departmentName,
        className: l.className,
        creditBucket: l.creditBucket,
        memo,
        cents: 0,
        columns: new Map(),
      };
      out.set(key, g);
    }
    g.cents += Math.round(l.amount * 100);
    for (const s of sourcesOf(i)) {
      const c = g.columns.get(s.column) ?? { cents: 0, employees: 0 };
      c.cents += Math.round(s.amount * 100);
      // Headcounts from two buckets that collapse to one row can overlap, so the merged
      // figure is the larger of the two, never the sum — an inflated headcount reads as a
      // bigger department than exists.
      c.employees = Math.max(c.employees, s.employees);
      g.columns.set(s.column, c);
    }
  });
  return out;
}

/**
 * @returns the single `ADP source detail` sheet, or `[]` when the stored entry and a fresh
 *   build of its source rows do not line up (a mapping edited since the draft was stored, a
 *   run rebuilt under different rules). Nothing is guessed at.
 */
export function buildPayrollJeDetailSheets(input: PayrollDetailInput): DetailSheet[] {
  const { storedLines, rebuiltLines, rebuiltSources, memoSuffix } = input;

  const stripSuffix = (memo: string): string =>
    memoSuffix !== '' && memo.endsWith(memoSuffix) ? memo.slice(0, -memoSuffix.length) : memo;

  const stored = collapse(storedLines, (l) => stripSuffix(l.memo), () => []);
  const rebuilt = collapse(rebuiltLines, (l) => l.memo, (i) => rebuiltSources[i] ?? []);

  // Relaxed index: only the keys that name exactly ONE group on each side (see `relaxedKey`).
  const relaxed = new Map<string, Group>();
  const countRelaxed = (groups: Map<string, Group>): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const g of groups.values()) {
      const k = relaxedKey(asLine(g), g.memo);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  };
  const storedCounts = countRelaxed(stored);
  const rebuiltCounts = countRelaxed(rebuilt);
  for (const g of rebuilt.values()) {
    const k = relaxedKey(asLine(g), g.memo);
    if (storedCounts.get(k) === 1 && rebuiltCounts.get(k) === 1) relaxed.set(k, g);
  }

  const rows: Record<string, CellValue>[] = [];
  const generated = new Set(
    storedLines.filter((l) => l.origin === 'generated').map((l) => groupKey(l, stripSuffix(l.memo))),
  );

  for (const [key, g] of stored) {
    const base = {
      type: g.postingType,
      account: g.accountName,
      memo: g.memo,
      department: g.departmentName ?? '',
      className: g.className ?? '',
    };

    if (!generated.has(key)) {
      rows.push({ ...base, adpColumn: NO_SOURCE, employees: null, ...sides(g.postingType, g.cents) });
      continue;
    }

    const source = rebuilt.get(key) ?? relaxed.get(relaxedKey(asLine(g), g.memo));
    if (!source || source.columns.size === 0) return [];
    const cols = [...source.columns.entries()];
    const shares = prorate(g.cents, cols.map(([, c]) => c.cents));
    cols.forEach(([column, c], i) => {
      if (shares[i] === 0) return;
      rows.push({ ...base, adpColumn: column, employees: c.employees, ...sides(g.postingType, shares[i]) });
    });
  }

  if (rows.length === 0) return [];

  const totalDebits = sumCol(rows, 'debit');
  const totalCredits = sumCol(rows, 'credit');
  const storedDebits = sumLines(storedLines, 'Debit');
  const storedCredits = sumLines(storedLines, 'Credit');
  // The tie, checked rather than asserted: if the sheet does not foot to the entry, ship no
  // sheet. Exact by construction above, so a failure here means an assumption broke.
  if (totalDebits !== storedDebits || totalCredits !== storedCredits) return [];

  rows.push({
    type: 'TOTAL', account: '', memo: '', department: '', className: '',
    adpColumn: '', employees: null, debit: totalDebits, credit: totalCredits,
  });

  return [
    {
      name: 'ADP source detail',
      columns: COLUMNS,
      rows,
      note:
        `${input.label} — the ADP columns behind each posted line. Debit/Credit total ` +
        `${totalDebits.toFixed(2)} / ${totalCredits.toFixed(2)}, footing to the journal entry. ` +
        'Aggregated to department/class: no employee names, ids or per-person amounts — Employees is a headcount. ' +
        (memoSuffix === ''
          ? ''
          : 'This entry is one month of a straddling run, so each column is prorated by the same calendar-day ratio as the line it sits under. '),
    },
  ];
}

function sides(postingType: JournalLine['postingType'], cents: number): { debit: number | null; credit: number | null } {
  const amount = cents / 100;
  return postingType === 'Debit' ? { debit: amount, credit: null } : { debit: null, credit: amount };
}

function sumCol(rows: readonly Record<string, CellValue>[], key: 'debit' | 'credit'): number {
  let cents = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === 'number') cents += Math.round(v * 100);
  }
  return cents / 100;
}

function sumLines(lines: readonly JournalLine[], postingType: JournalLine['postingType']): number {
  let cents = 0;
  for (const l of lines) if (l.postingType === postingType) cents += Math.round(l.amount * 100);
  return cents / 100;
}
