/**
 * Clipboard parsing for the manual-forecast grid.
 *
 * Pure and total — never throws. Bad cells become `errors` entries and the good rows
 * still land, so a leader pasting a messy Excel range keeps whatever parsed.
 *
 * Two accepted shapes:
 *   'pairs'   — 2+ columns: [month, amount]  (extra columns ignored)
 *   'amounts' — 1 column: amounts only; caller fills them down onto existing month rows
 *
 * The FE has no test harness, so this module is kept dependency-free and pure to stay
 * trivially testable once one exists.
 */

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const MIN_YEAR = 2020;
const MAX_YEAR = 2035;

function mk(year: number, month: number): number | null {
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  if (month < 1 || month > 12) return null;
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  return year * 100 + month;
}

/**
 * Accepts: "2026-08", "2026/8", "2026-08-01", "8/2026", "08-2026",
 *          "Aug 2026", "August 2026", "Aug-2026".
 * Returns a sortKey (year*100+month) or null.
 */
export function parseMonthToken(raw: string): number | null {
  const s = raw.trim().replace(/^"|"$/g, "");
  if (!s) return null;

  // YYYY-MM / YYYY/MM / YYYY-MM-DD
  let m = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(s);
  if (m) return mk(Number(m[1]), Number(m[2]));

  // MM/YYYY / MM-YYYY
  m = /^(\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return mk(Number(m[2]), Number(m[1]));

  // "Aug 2026" / "August 2026" / "Aug-2026"
  m = /^([A-Za-z]{3,9})[ \-/](\d{4})$/.exec(s);
  if (m) {
    const mo = MONTH_NAMES[m[1].toLowerCase()];
    if (mo) return mk(Number(m[2]), mo);
  }
  return null;
}

/** Accepts "2,100", "$2100", " 2100 ", "2100.0", "-2000". Returns an integer (may be negative) or null. */
export function parseAmountToken(raw: string): number | null {
  const s = raw.trim().replace(/^"|"$/g, "").replace(/[$,\s]/g, "");
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

export interface PastedPair { sortKey: number; amount: number }

export type PasteParseResult =
  | { kind: "pairs"; pairs: PastedPair[]; errors: string[] }
  | { kind: "amounts"; amounts: number[]; errors: string[] }
  | { kind: "empty"; errors: string[] };

function splitCells(line: string): string[] {
  // Excel copies as TSV. Fall back to comma for CSV pastes.
  return (line.includes("\t") ? line.split("\t") : line.split(",")).map(c => c.trim());
}

export function parseClipboard(text: string): PasteParseResult {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length) return { kind: "empty", errors: ["Clipboard was empty"] };

  const rows = lines.map(splitCells);
  const multiCol = rows.some(r => r.length >= 2);
  const errors: string[] = [];

  if (multiCol) {
    const pairs: PastedPair[] = [];
    rows.forEach((cells, i) => {
      if (cells.length < 2) {
        errors.push(`Row ${i + 1}: expected a month and an amount`);
        return;
      }
      const sortKey = parseMonthToken(cells[0]);
      const amount = parseAmountToken(cells[1]);
      if (sortKey === null) {
        // A header row like "Month | Amount" is common — skip it silently on row 1.
        if (i === 0 && parseAmountToken(cells[1]) === null) return;
        errors.push(`Row ${i + 1}: "${cells[0]}" is not a recognizable month`);
        return;
      }
      if (amount === null) {
        errors.push(`Row ${i + 1}: "${cells[1]}" is not a valid amount`);
        return;
      }
      pairs.push({ sortKey, amount });
    });
    return { kind: "pairs", pairs, errors };
  }

  const amounts: number[] = [];
  rows.forEach((cells, i) => {
    const amount = parseAmountToken(cells[0]);
    if (amount === null) {
      if (i === 0) return; // tolerate a single header cell
      errors.push(`Row ${i + 1}: "${cells[0]}" is not a valid amount`);
      return;
    }
    amounts.push(amount);
  });
  return { kind: "amounts", amounts, errors };
}
