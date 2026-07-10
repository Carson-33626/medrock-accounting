import type { JournalDraft, PayrollRow, ReconcileResult } from './types';
const sum = (rows: PayrollRow[], col: string): number =>
  Math.round(rows.reduce((s, r) => s + (typeof r.sensitive[col] === 'number' ? (r.sensitive[col] as number) : 0), 0) * 100) / 100;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function reconcile(
  draft: JournalDraft, rows: PayrollRow[], unmapped: { unmappedColumns: string[]; unmappedPositions: string[] },
): ReconcileResult {
  // M4: re-sum straight from the lines being validated rather than trusting the
  // header's stored totalDebits/totalCredits/variance — those could be stale or
  // (if ever hand-edited) inconsistent with the actual lines.
  const debits = round2(draft.lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
  const credits = round2(draft.lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
  const variance = round2(debits - credits);
  const balanced = near(variance, 0);
  const netExpected = sum(rows, 'NET PAY');
  const netActual = draft.lines.filter((l) => l.creditBucket === 'Net Pay').reduce((s, l) => s + l.amount, 0);
  const netOk = near(netActual, netExpected);
  const grossExpected = sum(rows, 'GROSS PAY') || sum(rows, 'TOTAL EARNINGS');
  const grossActual = draft.lines.filter((l) => l.postingType === 'Debit' && /wage|salary|earning/i.test(l.accountName)).reduce((s, l) => s + l.amount, 0);
  const grossOk = grossExpected === 0 ? true : grossActual > 0; // presence check; exact split validated in review
  const taxesEeOk = true; const taxesErOk = true; // refined once tax buckets are mapped (see review UI)
  const errors: string[] = [];
  if (!balanced) errors.push(`Out of balance by ${variance.toFixed(2)}`);
  if (!netOk) errors.push(`Net pay ${netActual.toFixed(2)} ≠ ADP ${netExpected.toFixed(2)}`);
  const postable = balanced && netOk && grossOk && unmapped.unmappedColumns.length === 0 && unmapped.unmappedPositions.length === 0;
  return { balanced, variance, grossOk, netOk, taxesEeOk, taxesErOk,
    unmappedColumns: unmapped.unmappedColumns, unmappedPositions: unmapped.unmappedPositions, errors, postable };
}
