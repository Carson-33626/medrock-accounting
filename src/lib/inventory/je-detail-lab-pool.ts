/**
 * The lab-supplies basis behind the monthly close entry, as an extra sheet of the
 * entry's own workbook — the pooled successor to `je-detail-accrual.ts`.
 *
 * Since 2026-09-14 the lab accrual is a contributor INSIDE the close entry
 * (`lab-supplies-contribution.ts`), booking target − posted rather than an
 * accrual/reversal pair. The estimate still depends on the day QuickBooks was read
 * (completeness is a function of `asOf`), so the generate step retains the basis on
 * the close header (`saveSourceSnapshot`) and this builder reads THAT, never a
 * re-pull. Same footing contract as the pair's sheet: the stored lab lines must
 * reproduce the snapshot's delta to the cent, or nothing is emitted.
 */
import type { CellValue, ExportColumn } from '@/lib/inventory-export';
import type { DetailSheet } from './je-detail';
import type { JsonValue } from '@/lib/payroll/store';
import type { JournalLine } from '@/lib/payroll/types';

const COLUMNS: ExportColumn[] = [
  { header: 'Month', key: 'month' },
  { header: 'Step', key: 'step' },
  { header: 'Basis', key: 'basis' },
  { header: 'Value', key: 'value' },
  { header: 'Amount', key: 'amount', currency: true },
  { header: 'Debit', key: 'debit', currency: true },
  { header: 'Credit', key: 'credit', currency: true },
];

/** One month's contribution to the target, as retained at generate time. */
export type LabSuppliesPoolMonth = {
  month: string;
  observedToDate: number;
  observedDocs: number;
  daysElapsed: number;
  completeness: number;
  boundBy: 'curve' | 'entry';
  trailingAverage: number;
  accrual: number;
  flagged: boolean;
  flagReason: string | null;
};

/* Alias, not interface: an alias has an implicit index signature and persists straight to
 * the jsonb column as a JsonValue without a cast. */
export type LabSuppliesPoolSnapshot = {
  kind: 'lab-supplies-pool';
  location: string;
  /** The close month. */
  month: string;
  /** ISO date the QuickBooks observation was taken. */
  asOf: string;
  /** Σ accrual over `months` — the accrued balance that should stand at month-end. */
  target: number;
  /** Σ of our posted lab-supplies lines to date, before this entry. */
  postedToDate: number;
  /** target − postedToDate: what the lab lines in this entry book. */
  delta: number;
  months: LabSuppliesPoolMonth[];
};

const num = (v: JsonValue | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: JsonValue | undefined): string | null => (typeof v === 'string' ? v : null);

function parseMonth(value: JsonValue): LabSuppliesPoolMonth | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const month = str(value.month);
  const boundBy = str(value.boundBy);
  const observedToDate = num(value.observedToDate);
  const observedDocs = num(value.observedDocs);
  const daysElapsed = num(value.daysElapsed);
  const completeness = num(value.completeness);
  const trailingAverage = num(value.trailingAverage);
  const accrual = num(value.accrual);
  const flagReason = value.flagReason === null ? null : str(value.flagReason);
  if (month === null || (boundBy !== 'curve' && boundBy !== 'entry') || typeof value.flagged !== 'boolean') return null;
  if (
    observedToDate === null || observedDocs === null || daysElapsed === null ||
    completeness === null || trailingAverage === null || accrual === null
  ) {
    return null;
  }
  return { month, observedToDate, observedDocs, daysElapsed, completeness, boundBy, trailingAverage, accrual, flagged: value.flagged, flagReason };
}

/** Narrow a stored jsonb snapshot back to `LabSuppliesPoolSnapshot`, or null on ANY mismatch. */
export function parseLabSuppliesPoolSnapshot(value: JsonValue | null): LabSuppliesPoolSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (value.kind !== 'lab-supplies-pool') return null;
  const location = str(value.location);
  const month = str(value.month);
  const asOf = str(value.asOf);
  const target = num(value.target);
  const postedToDate = num(value.postedToDate);
  const delta = num(value.delta);
  if (location === null || month === null || asOf === null || target === null || postedToDate === null || delta === null) return null;
  if (!Array.isArray(value.months)) return null;
  const months: LabSuppliesPoolMonth[] = [];
  for (const m of value.months) {
    const parsed = parseMonth(m);
    if (parsed === null) return null;
    months.push(parsed);
  }
  return { kind: 'lab-supplies-pool', location, month, asOf, target, postedToDate, delta, months };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const cents = (n: number): number => Math.round(n * 100);

/**
 * @param labLines the entry's lab-supplies lines ONLY (those tagged `src:lab-supplies`),
 *   as persisted on the header.
 * @returns the single `Lab supplies basis` sheet, or `[]` when the lines do not reproduce
 *   the snapshot's delta.
 */
export function buildLabSuppliesPoolDetailSheet(
  labLines: readonly JournalLine[],
  snapshot: LabSuppliesPoolSnapshot,
): DetailSheet[] {
  const deltaCents = cents(Math.abs(snapshot.delta));
  // THE TIE: zero delta → no lab lines; otherwise exactly one Dr and one Cr of |delta|.
  if (deltaCents === 0) {
    if (labLines.length !== 0) return [];
  } else {
    if (labLines.length !== 2) return [];
    const debits = labLines.filter((l) => l.postingType === 'Debit');
    const credits = labLines.filter((l) => l.postingType === 'Credit');
    if (debits.length !== 1 || credits.length !== 1) return [];
    if (cents(debits[0].amount) !== deltaCents || cents(credits[0].amount) !== deltaCents) return [];
  }

  const rows: Record<string, CellValue>[] = [];
  for (const m of snapshot.months) {
    rows.push({
      month: m.month,
      step: 'Observed to date',
      basis: `Bills + Purchases coded to 1220.20 / 5000.25, read from QuickBooks ${snapshot.asOf}`,
      value: `${m.observedDocs} document${m.observedDocs === 1 ? '' : 's'}`,
      amount: m.observedToDate,
      debit: null,
      credit: null,
    });
    rows.push({
      month: m.month,
      step: 'Completeness applied',
      basis: `${m.daysElapsed} day${m.daysElapsed === 1 ? '' : 's'} after month end, bound by ${m.boundBy}`,
      value: pct(m.completeness),
      amount: null,
      debit: null,
      credit: null,
    });
    rows.push({
      month: m.month,
      step: 'Still unkeyed (accrual)',
      basis: `(1 − ${pct(m.completeness)}) × trailing average ${m.trailingAverage.toFixed(2)}`,
      value: '',
      amount: m.accrual,
      debit: null,
      credit: null,
    });
    if (m.flagged && m.flagReason !== null) {
      rows.push({ month: m.month, step: 'FLAGGED', basis: m.flagReason, value: '', amount: null, debit: null, credit: null });
    }
  }
  rows.push({
    month: snapshot.month,
    step: 'Target accrued balance',
    basis: 'Σ still-unkeyed spend across the months above — what 2011 should carry for lab supplies at month end',
    value: '',
    amount: snapshot.target,
    debit: null,
    credit: null,
  });
  rows.push({
    month: snapshot.month,
    step: 'Posted to date',
    basis: 'Σ of our own posted lab-supplies lines (credits to 2011 less debits), from the audited draft history',
    value: '',
    amount: snapshot.postedToDate,
    debit: null,
    credit: null,
  });
  rows.push({
    month: snapshot.month,
    step: 'This entry books',
    basis: 'Target − posted to date. Positive: Dr 5000.25 / Cr 2011. Negative: the reverse.',
    value: '',
    amount: snapshot.delta,
    debit: null,
    credit: null,
  });
  for (const line of labLines) {
    rows.push({
      month: snapshot.month,
      step: line.postingType === 'Debit' ? 'Dr' : 'Cr',
      basis: line.accountName,
      value: line.memo,
      amount: null,
      debit: line.postingType === 'Debit' ? line.amount : null,
      credit: line.postingType === 'Credit' ? line.amount : null,
    });
  }
  const total = deltaCents / 100;
  rows.push({ month: '', step: 'TOTAL', basis: '', value: '', amount: null, debit: total, credit: total });

  return [
    {
      name: 'Lab supplies basis',
      columns: COLUMNS,
      rows,
      note:
        `Lab supplies are bought ad hoc and never received into LifeFile, so FIFO cannot see them. ` +
        `This entry sets the accrued liability for spend not yet keyed to $${snapshot.target.toFixed(2)} ` +
        `(target − posted to date = $${snapshot.delta.toFixed(2)}). No reversal: the balance is re-set every ` +
        `month from scratch, and a month whose bills have all landed contributes $0 to the target.`,
    },
  ];
}
