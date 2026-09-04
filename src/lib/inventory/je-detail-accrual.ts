/**
 * The estimate behind a posted lab-supplies accrual (or its reversal), shaped as an extra
 * sheet of the entry's own workbook.
 *
 * WHY THIS ONE NEEDED A RETAINED SNAPSHOT AND THE OTHER KINDS DID NOT
 *
 * The inventory close reads back the lot ids its draft stored; the allocation reads back the
 * pool snapshot `payroll_eom_runs` retains; the payroll rebuild is checked against the stored
 * entry. All three can look at their source again and get the same answer.
 *
 * The accrual cannot. Its completeness is a function of `asOf` — how many days have passed
 * since month end and how many bills have been keyed BY NOW — so re-pulling QuickBooks a day
 * after the draft was generated returns a different, smaller accrual than the one that posted.
 * A sheet built from that re-pull would not foot, and under the DS §11.3 rule it would ship
 * nothing at all, every time. So `generateLabAccrualDrafts` retains the five inputs that
 * determine the number (`saveSourceSnapshot`) and this builder reads THEM. That is DS §6's
 * "start retaining the source snapshot" recommendation applied to the one path that needs it
 * most.
 *
 * FOOTING IS THE CONTRACT (DS §7 acceptance 2): the sheet's Debit/Credit totals are taken from
 * the stored entry itself and the snapshot's accrual must reproduce them to the cent, or the
 * builder returns nothing. A detail file that does not add up is worse than no attachment.
 */
import type { CellValue, ExportColumn } from '@/lib/inventory-export';
import type { DetailSheet } from './je-detail';
import type { JsonValue } from '@/lib/payroll/store';
import type { JournalLine } from '@/lib/payroll/types';

const COLUMNS: ExportColumn[] = [
  { header: 'Step', key: 'step' },
  { header: 'Basis', key: 'basis' },
  { header: 'Value', key: 'value' },
  { header: 'Amount', key: 'amount', currency: true },
  { header: 'Debit', key: 'debit', currency: true },
  { header: 'Credit', key: 'credit', currency: true },
];

/**
 * The inputs and result of ONE `computeAccrual` call, as retained at generate time.
 *
 * Every field the sheet prints is here rather than re-read from today's constants: a trailing
 * average that gets re-fitted next quarter must not silently restate a posted entry's basis.
 */
/* A type alias, not an interface, deliberately: TypeScript gives an alias an implicit index
 * signature, which is what lets a snapshot be persisted straight to a `JsonValue` jsonb column
 * without a cast. */
export type LabAccrualSnapshot = {
  location: string;
  /** 'YYYY-MM' — the accrued month, not the posting date. */
  month: string;
  /** ISO date the QuickBooks observation was taken, which is what fixes completeness. */
  asOf: string;
  observedToDate: number;
  observedDocs: number;
  normalDocs: number;
  daysElapsed: number;
  curveCompleteness: number;
  entryCompleteness: number;
  completeness: number;
  boundBy: 'curve' | 'entry';
  trailingAverage: number;
  accrual: number;
  estimatedTotal: number;
  flagged: boolean;
  flagReason: string | null;
  borrowedCurve: boolean;
};

const num = (v: JsonValue | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: JsonValue | undefined): string | null => (typeof v === 'string' ? v : null);

/**
 * Narrow a stored jsonb snapshot back to `LabAccrualSnapshot`, or null on ANY shape mismatch.
 *
 * Strict on purpose: a partially-read snapshot would print a basis with holes in it next to a
 * real posted entry, and half an explanation reads as a whole one.
 */
export function parseLabAccrualSnapshot(value: JsonValue | null): LabAccrualSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const location = str(value.location);
  const month = str(value.month);
  const asOf = str(value.asOf);
  const boundBy = str(value.boundBy);
  const flagReason = value.flagReason === null ? null : str(value.flagReason);
  if (location === null || month === null || asOf === null) return null;
  if (boundBy !== 'curve' && boundBy !== 'entry') return null;
  if (typeof value.flagged !== 'boolean' || typeof value.borrowedCurve !== 'boolean') return null;

  const observedToDate = num(value.observedToDate);
  const observedDocs = num(value.observedDocs);
  const normalDocs = num(value.normalDocs);
  const daysElapsed = num(value.daysElapsed);
  const curveCompleteness = num(value.curveCompleteness);
  const entryCompleteness = num(value.entryCompleteness);
  const completeness = num(value.completeness);
  const trailingAverage = num(value.trailingAverage);
  const accrual = num(value.accrual);
  const estimatedTotal = num(value.estimatedTotal);
  if (
    observedToDate === null || observedDocs === null || normalDocs === null || daysElapsed === null ||
    curveCompleteness === null || entryCompleteness === null || completeness === null ||
    trailingAverage === null || accrual === null || estimatedTotal === null
  ) {
    return null;
  }

  return {
    location, month, asOf, observedToDate, observedDocs, normalDocs, daysElapsed,
    curveCompleteness, entryCompleteness, completeness, boundBy, trailingAverage,
    accrual, estimatedTotal, flagged: value.flagged, flagReason,
    borrowedCurve: value.borrowedCurve,
  };
}

export interface LabAccrualDetailInput {
  /** The lines as PERSISTED on the header being posted or downloaded. */
  storedLines: readonly JournalLine[];
  /** The retained estimate the draft was generated from. */
  snapshot: LabAccrualSnapshot;
  /** 'accrual' books the estimate; 'reversal' takes the same amount back off. */
  kind: 'accrual' | 'reversal';
  /** One-line banner: entity, doc number, date. */
  label: string;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const cents = (n: number): number => Math.round(n * 100);

/**
 * @returns the single `Accrual basis` sheet, or `[]` when the snapshot does not reproduce the
 *   stored entry — a regenerated draft whose snapshot was never re-saved, a hand-edited entry,
 *   or a pair that is not the two-line shape `buildLabAccrualDrafts` emits.
 */
export function buildLabAccrualJeDetailSheets(input: LabAccrualDetailInput): DetailSheet[] {
  const { storedLines, snapshot, kind } = input;

  // THE TIE. The pair is two lines of one amount by construction, and that amount IS the
  // snapshot's accrual. Anything else means the snapshot no longer explains the entry.
  if (storedLines.length !== 2) return [];
  const debits = storedLines.filter((l) => l.postingType === 'Debit');
  const credits = storedLines.filter((l) => l.postingType === 'Credit');
  if (debits.length !== 1 || credits.length !== 1) return [];
  const accrualCents = cents(snapshot.accrual);
  if (cents(debits[0].amount) !== accrualCents || cents(credits[0].amount) !== accrualCents) return [];

  const borrowed = snapshot.borrowedCurve ? ' (curve borrowed from another location)' : '';
  const rows: Record<string, CellValue>[] = [
    {
      step: 'Observed to date',
      basis: `Bills + Purchases coded to 1220.20 / 5000.25 in ${snapshot.month}, read from QuickBooks ${snapshot.asOf}`,
      value: `${snapshot.observedDocs} document${snapshot.observedDocs === 1 ? '' : 's'}`,
      amount: snapshot.observedToDate,
      debit: null,
      credit: null,
    },
    {
      step: 'Trailing monthly average',
      basis: `Measured baseline for ${snapshot.location} — what a full month of lab supplies costs`,
      value: '',
      amount: snapshot.trailingAverage,
      debit: null,
      credit: null,
    },
    {
      step: 'Curve completeness',
      basis: `${snapshot.daysElapsed} day${snapshot.daysElapsed === 1 ? '' : 's'} after month end${borrowed} — what elapsed time suggests is keyed`,
      value: pct(snapshot.curveCompleteness),
      amount: null,
      debit: null,
      credit: null,
    },
    {
      step: 'Entry completeness',
      basis: `${snapshot.observedDocs} of the ${snapshot.normalDocs} documents a normal month carries — what entry activity shows`,
      value: pct(snapshot.entryCompleteness),
      amount: null,
      debit: null,
      credit: null,
    },
    {
      step: 'Completeness applied',
      basis: `The LOWER of the two, bound by ${snapshot.boundBy}`,
      value: pct(snapshot.completeness),
      amount: null,
      debit: null,
      credit: null,
    },
    {
      step: 'Accrual',
      basis: `(1 − ${pct(snapshot.completeness)}) × ${snapshot.trailingAverage.toFixed(2)} — the part of the month nobody has keyed yet`,
      value: '',
      amount: snapshot.accrual,
      debit: null,
      credit: null,
    },
    {
      step: 'Estimated month total',
      basis: 'Observed to date + accrual — what the month is expected to have cost',
      value: '',
      amount: snapshot.estimatedTotal,
      debit: null,
      credit: null,
    },
  ];

  if (snapshot.flagged && snapshot.flagReason !== null) {
    rows.push({
      step: 'FLAGGED', basis: snapshot.flagReason, value: '', amount: null, debit: null, credit: null,
    });
  }

  // The entry itself, read off the stored lines rather than reconstructed, so the two halves of
  // the pair each print the direction they actually posted in.
  for (const line of storedLines) {
    rows.push({
      step: line.postingType === 'Debit' ? 'Dr' : 'Cr',
      basis: line.accountName,
      value: line.memo,
      amount: null,
      debit: line.postingType === 'Debit' ? line.amount : null,
      credit: line.postingType === 'Credit' ? line.amount : null,
    });
  }

  const total = accrualCents / 100;
  rows.push({ step: 'TOTAL', basis: '', value: '', amount: null, debit: total, credit: total });

  const reversalNote =
    kind === 'reversal'
      ? 'This is the REVERSAL half: it takes the same estimate back off on the first of the following month, ' +
        'so the real bills — once keyed to 1220.20 and expensed by the FIFO close — cannot double-count it. '
      : 'Reverses on the first of the following month, so the real bills cannot double-count it. ';

  return [
    {
      name: 'Accrual basis',
      columns: COLUMNS,
      rows,
      note:
        `${input.label} — the estimate behind this entry, as measured on ${snapshot.asOf}. ` +
        reversalNote +
        `Lab supplies are bought ad hoc and never route through LifeFile, so FIFO cannot see them; ` +
        `the accrual covers what was received in ${snapshot.month} and not yet billed. ` +
        `Debit/Credit total ${total.toFixed(2)} / ${total.toFixed(2)}, footing to the journal entry.`,
    },
  ];
}
