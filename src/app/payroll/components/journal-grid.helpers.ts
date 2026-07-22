/**
 * Pure, framework-free helpers for the QuickBooks-style journal grid.
 * NO React and NO `pg`/store imports — safe to unit-test and safe in a client bundle.
 * The line/roster types are re-declared here (not imported from the pg-backed
 * types.ts) so this module and the grid components can share them freely.
 */

export type PostingType = 'Debit' | 'Credit';
export type LineOrigin = 'generated' | 'manual' | 'inter_entity';
export type CreditBucket =
  | 'Net Pay'
  | 'Taxes'
  | 'Garnishments'
  | 'Retirement'
  | 'Health'
  | 'WC'
  | 'Other';

export interface JournalLine {
  postingType: PostingType;
  amount: number;
  accountName: string;
  departmentName: string | null;
  className: string | null;
  memo: string;
  creditBucket: CreditBucket | null;
  origin: LineOrigin;
  sourceRowKeys: string[];
}

/** Minimal roster shape the Name column needs — rowKey → display name. */
export interface RosterName {
  rowKey: string;
  name: string;
}

/**
 * QuickBooks sets a line's side by which amount cell you type into. Given the edited
 * `side` and its new numeric `value`, return the patch to apply to the line:
 * - same side as the line → just update the amount
 * - opposite side on an editable (non-generated) line → flip the side and move the amount
 * - opposite side on a generated line → no change (its side is fixed by the builder)
 */
export function applyAmountEdit(line: JournalLine, side: PostingType, value: number): Partial<JournalLine> {
  if (side === line.postingType) return { amount: value };
  if (line.origin === 'generated') return {};
  return { postingType: side, amount: value };
}

/**
 * Compact preview of the people on a line for the QB "Name" column, e.g. "Bob, Jane +8".
 * Resolves `sourceRowKeys` against the already-loaded roster (no fetch). When keys exist but
 * none resolve to a name, falls back to "(N people)". Empty key list → "".
 */
export function sourceNamesPreview(
  sourceRowKeys: string[],
  roster: readonly RosterName[],
  max = 2,
): string {
  if (sourceRowKeys.length === 0) return '';
  const byKey = new Map(roster.map((r) => [r.rowKey, r.name]));
  const names = sourceRowKeys.map((k) => byKey.get(k)).filter((n): n is string => Boolean(n));
  if (names.length === 0) return `(${sourceRowKeys.length} people)`;
  const shown = names.slice(0, max).join(', ');
  const overflow = names.length - Math.min(max, names.length);
  return overflow > 0 ? `${shown} +${overflow}` : shown;
}
