/**
 * Month-end allocation difference + correction entries — the pure half.
 * See docs/superpowers/specs/2026-09-25-eom-difference-check-design.md.
 */
import type { Entity, JournalLine } from './types';
import { eomDocNumber } from './month-end';
import type { Month } from './month';

export const DELTA_MEMO = 'Month-end allocation correction';

/**
 * Lines still needed so the books hold `target`: target minus everything already posted,
 * netted per account name (IE legs encode their counterparty in the account name), signed
 * Debit + / Credit −, in integer cents. A remainder that flips sign flips side. Both inputs
 * balance, so the result balances. Accounts only in the posted sets take `defaultMemo`.
 */
export function remainderLines(
  target: readonly JournalLine[], postedSets: readonly (readonly JournalLine[])[], defaultMemo: string,
): JournalLine[] {
  const acc = new Map<string, { cents: number; memo: string }>();
  const add = (l: JournalLine, sign: 1 | -1, keepMemo: boolean): void => {
    const cur = acc.get(l.accountName) ?? { cents: 0, memo: defaultMemo };
    cur.cents += sign * (l.postingType === 'Debit' ? 1 : -1) * Math.round(l.amount * 100);
    if (keepMemo && l.memo !== '') cur.memo = l.memo;
    acc.set(l.accountName, cur);
  };
  for (const l of target) add(l, 1, true);
  for (const set of postedSets) for (const l of set) add(l, -1, false);

  const out: JournalLine[] = [];
  for (const [accountName, v] of acc) {
    if (v.cents === 0) continue;
    out.push({
      postingType: v.cents > 0 ? 'Debit' : 'Credit', amount: Math.abs(v.cents) / 100, accountName,
      departmentName: null, className: null, memo: v.memo, creditBucket: null, origin: 'inter_entity', sourceRowKeys: [],
    });
  }
  return out;
}

export function deltaDebits(lines: readonly JournalLine[]): number {
  const cents = lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + Math.round(l.amount * 100), 0);
  return cents / 100;
}

export function isFlagged(delta: number, threshold: number): boolean {
  return delta > 0 && delta >= threshold;
}

export function eomCorrectionSegment(index: number): string { return `C${index}`; }
export function eomCorrectionIndex(segment: string): number | null {
  const m = /^C([1-9]\d*)$/.exec(segment);
  return m ? Number(m[1]) : null;
}
export function eomCorrectionDocNumber(entity: Entity, m: Month, index: number): string {
  return `${eomDocNumber(entity, m)}-${index + 1}`;
}
export function eomCorrectionNote(entity: Entity, m: Month, index: number, foundIso: string): string {
  return (
    `Month-end allocation correction ${index} to ${eomDocNumber(entity, m)} — difference found ${foundIso}: ` +
    'late pool activity / revenue share changes since the entry posted.'
  );
}

/**
 * Fingerprint of the posted set a correction is netted against (parent + posted corrections
 * for one month/entity): the sorted `"<id>:<qb_entry_id>"` list. Stored as the correction's
 * `source_snapshot_hash` at generation and recomputed at live post — any post, pull-back or
 * repost (new QuickBooks id) since generation changes it (final review I1).
 */
export function eomPostedSetFingerprint(headers: ReadonlyArray<{ id: number; qb_entry_id: string | null }>): string {
  const parts = [...headers].sort((a, b) => a.id - b.id).map((h) => `${h.id}:${h.qb_entry_id ?? ''}`);
  return `eom-posted:${parts.join(',')}`;
}

export interface EomDiffSettings { threshold: number; enabled: boolean; checkFromMonth: string }

/** accounting.eom_diff_settings.threshold is numeric(12,2). */
const MAX_THRESHOLD = 9_999_999_999.99;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function validateSettings(
  input: { threshold?: number; enabled?: boolean; checkFromMonth?: string },
): { ok: true; value: Partial<EomDiffSettings> } | { ok: false; error: string } {
  const value: Partial<EomDiffSettings> = {};
  if (input.threshold !== undefined) {
    if (typeof input.threshold !== 'number' || !Number.isFinite(input.threshold) || input.threshold < 0) {
      return { ok: false, error: 'threshold must be a number ≥ 0' };
    }
    const rounded = Math.round((input.threshold + Number.EPSILON) * 100) / 100;
    if (rounded > MAX_THRESHOLD) return { ok: false, error: 'threshold must be at most 9,999,999,999.99' };
    value.threshold = rounded;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
    value.enabled = input.enabled;
  }
  if (input.checkFromMonth !== undefined) {
    if (typeof input.checkFromMonth !== 'string' || !MONTH_RE.test(input.checkFromMonth)) {
      return { ok: false, error: 'checkFromMonth must be YYYY-MM' };
    }
    value.checkFromMonth = input.checkFromMonth;
  }
  return { ok: true, value };
}
