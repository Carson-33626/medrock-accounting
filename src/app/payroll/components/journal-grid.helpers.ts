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

// ── Source-detail structuring (per-person expansion under a line) ─────────────

export type DetailUnit = 'usd' | 'hours';
export type DetailGroup =
  | 'Earnings'
  | 'Employee deductions & taxes'
  | 'Employer costs'
  | 'Hours & rate'
  | 'Other';

export interface DetailRow {
  /** Human label (prettified from the ADP column name). */
  label: string;
  /** Pre-formatted display value ("$2,500.00" or "80.00 hrs"). */
  display: string;
  unit: DetailUnit;
  /** Raw numeric value — used only for within-group sorting. */
  raw: number;
}
export interface DetailSection {
  group: DetailGroup;
  rows: DetailRow[];
}

const detailUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const GROUP_ORDER: DetailGroup[] = [
  'Earnings',
  'Employee deductions & taxes',
  'Employer costs',
  'Hours & rate',
  'Other',
];

// Tokens kept UPPERCASE when prettifying a label (acronyms, state/plan codes).
const LABEL_ACRONYMS = new Set([
  'EE', 'ER', 'OT', 'WC', 'US', 'RS', 'PTO', 'HSA', 'FSA', 'SUI', 'SDI', 'FMLA', 'YTD', 'ADP',
  'PR', 'TX', 'FL', 'TN', 'GA', 'NC', 'SC', 'AZ', 'CO', 'IL', 'MD', 'OH', 'RI', 'NE', 'DC', 'VA', 'NY', 'CA', 'PA',
]);

/**
 * Classify an ADP sensitive-column name into a display group + unit, or null to DROP it
 * (derived/reference columns the JE builder also ignores: `… - TOTAL`, `TOTAL …`, `GROSS PAY`,
 * and any `… TAXABLE` base). First match wins; `\bER\b` is checked before EARNING/EE so an
 * employer-cost column like `MEDICAL - ER` is never mistaken for an earning or an EE line.
 */
export function classifyDetailColumn(col: string): { group: DetailGroup; unit: DetailUnit } | null {
  const c = col.trim().toUpperCase();
  if (/\bTAXABLE\b/.test(c)) return null;
  if (/-\s*TOTAL\s*$/.test(c) || /^TOTAL\b/.test(c) || c === 'GROSS PAY') return null;
  if (/\bHOURS\b/.test(c)) return { group: 'Hours & rate', unit: 'hours' };
  if (/\bRATE\b/.test(c)) return { group: 'Hours & rate', unit: 'usd' };
  if (/\bER\b/.test(c)) return { group: 'Employer costs', unit: 'usd' };
  if (/\bEARNINGS?\b/.test(c)) return { group: 'Earnings', unit: 'usd' };
  if (/\bEE\b/.test(c) || c === 'NET PAY' || /\b(GARNISH|CHILD PAYMENTS?|BKWITHHOLD)\b/.test(c)) {
    return { group: 'Employee deductions & taxes', unit: 'usd' };
  }
  return { group: 'Other', unit: 'usd' };
}

/** Currency for `usd`, "<n> hrs" for `hours`. */
export function formatDetailAmount(value: number, unit: DetailUnit): string {
  return unit === 'hours' ? `${value.toFixed(2)} hrs` : detailUsd.format(value);
}

function titleToken(tok: string): string {
  if (tok === '' || tok === '&' || tok === '-') return tok;
  const up = tok.toUpperCase();
  if (LABEL_ACRONYMS.has(up)) return up;
  if (/\d/.test(tok)) return up; // digit tokens (401K, 088086) stay as-is
  if (tok.includes('-')) return tok.split('-').map(titleToken).join('-'); // PRE-TAX -> Pre-Tax
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
}

/**
 * Human label from an ADP column name: title-cases words, keeps known acronyms/state codes
 * uppercase, preserves digit tokens and hyphen parts. Strips a trailing ` - EARNING` for the
 * Earnings group (the group header already says Earnings). Display-only.
 */
export function prettifyColumnLabel(col: string, group: DetailGroup): string {
  let s = col.trim();
  if (group === 'Earnings') s = s.replace(/\s*-\s*EARNINGS?\s*$/i, '');
  return s.split(/\s+/).map(titleToken).join(' ');
}

/**
 * Turn a decrypted per-person `sensitive` record into ordered, grouped display sections for the
 * line's source-detail expansion. Excludes zero/non-numeric columns and derived/reference columns,
 * groups the rest, orders groups (Earnings → Employee → Employer → Hours & rate → Other), sorts
 * rows within a group by descending |amount|, and omits empty groups.
 */
export function groupSourceDetail(sensitive: Record<string, number | string | null>): DetailSection[] {
  const byGroup = new Map<DetailGroup, DetailRow[]>();
  for (const [col, val] of Object.entries(sensitive)) {
    if (typeof val !== 'number' || val === 0) continue;
    const cls = classifyDetailColumn(col);
    if (!cls) continue;
    const row: DetailRow = {
      label: prettifyColumnLabel(col, cls.group),
      display: formatDetailAmount(val, cls.unit),
      unit: cls.unit,
      raw: val,
    };
    const list = byGroup.get(cls.group);
    if (list) list.push(row);
    else byGroup.set(cls.group, [row]);
  }
  const sections: DetailSection[] = [];
  for (const group of GROUP_ORDER) {
    const rows = byGroup.get(group);
    if (!rows || rows.length === 0) continue;
    rows.sort((a, b) => Math.abs(b.raw) - Math.abs(a.raw));
    sections.push({ group, rows });
  }
  return sections;
}
