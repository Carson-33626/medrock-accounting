import { formatAmount, inferDepositType, parseOcrAmount, parseOcrDate, type DepositType } from './naming';

/** The gateway's 200 response shape (see the OCR API quick-start). */
export interface OcrResponse {
  lines: string[];
  fullText: string;
  keyValues: Record<string, string>;
  tables: string[][][];
}

export interface DepositSuggestions {
  date: string | null;
  type: DepositType | null;
  amount: string | null;
}

export const EMPTY_SUGGESTIONS: DepositSuggestions = { date: null, type: null, amount: null };

// keyValues keys keep their trailing colon ("Date:", not "Date") — strip and
// lowercase before matching. (Documented gateway gotcha.)
function normalizeKey(key: string): string {
  return key.replace(/:\s*$/, '').trim().toLowerCase();
}

function findValueByKey(keyValues: Record<string, string>, matcher: RegExp): string | null {
  for (const [rawKey, value] of Object.entries(keyValues)) {
    if (matcher.test(normalizeKey(rawKey))) {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

// formatAmount throws on garbage; OCR values are untrusted, so swallow to null.
function tryFormatAmount(raw: string): string | null {
  try {
    return formatAmount(raw);
  } catch {
    return null;
  }
}

const AMOUNT_KEY = /(^|\s)(total|amount|deposit)(\s|$)/;
const DATE_KEY = /\bdate\b/;

/**
 * OCR response → suggested deposit fields. Every field is a best-effort guess:
 * when a value can't be confidently parsed it comes back null and the uploader
 * fills it in. Note we do NOT index `tables[0]` — Textract invents spurious
 * tables, so tables are ignored here entirely.
 */
export function extractDepositFields(ocr: OcrResponse, now: Date = new Date()): DepositSuggestions {
  const keyValues = ocr.keyValues ?? {};
  const fullText = ocr.fullText ?? '';

  const amountLabel = findValueByKey(keyValues, AMOUNT_KEY);
  const amount = (amountLabel ? tryFormatAmount(amountLabel) : null) ?? parseOcrAmount(fullText);

  const dateLabel = findValueByKey(keyValues, DATE_KEY);
  const date = (dateLabel ? parseOcrDate(dateLabel, now) : null) ?? parseOcrDate(fullText, now);

  const type = inferDepositType(fullText);

  return { date, type, amount };
}
