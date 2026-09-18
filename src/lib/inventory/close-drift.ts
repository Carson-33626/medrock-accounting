/**
 * Close drift: ordering gates, drift status and the early-post rule. Pure.
 *
 * Month-end inventory balances are cumulative, so every close entry (and every correction)
 * must be built and posted oldest-first, each generated after everything before it posted.
 * Barbara's 09-16 recheck found Jun–Aug drifting because AP kept landing after the 09-15
 * posts; the correction button fixes that, but only in order. These gates make the order
 * a rule instead of a habit. See docs/fifo-monthly-close/ds-close-drift-guard-2026-09-18.md.
 */

/** One stored INV CLOSE / INV OPEN header, reduced to what ordering needs. */
export interface CloseHeaderRef {
  id: number;
  entity: string;
  /** 'YYYY-MM' — the period month (INV OPEN is '2025-12'). */
  month: string;
  /** '' for the month's regular entry, 'C1', 'C2', … for corrections. */
  segment: string;
  status: string;
  docNumber: string | null;
  /** ISO — latest `generated` audit stamp; null for drafts built before stamping began. */
  generatedAt: string | null;
  /** ISO — latest `posted` audit stamp; null when not posted. */
  postedAt: string | null;
}

/**
 * Below this a posted month counts as tying. Not $1: the nightly ledger reload moves FIFO by
 * tens of dollars (TN Jan–May read $41–$55 on 2026-09-18), and a $1 bar would force a chain of
 * $50 corrections before the real one. A sub-threshold gap is never corrected on its own, so it
 * rolls into the next month's correction once and cannot be booked twice.
 */
export const DRIFT_TOLERANCE = 250;

/** Days after month-end before AP is treated as substantially keyed (lab curve: ~93% at 30). */
export const SETTLE_DAYS = 30;

const isCorrection = (h: CloseHeaderRef): boolean => /^C[1-9]\d*$/.test(h.segment);
const label = (h: CloseHeaderRef): string => h.docNumber ?? `${h.entity} ${h.month}${h.segment ? ` ${h.segment}` : ''}`;
const time = (iso: string | null): number => (iso === null ? Number.NaN : Date.parse(iso));

/**
 * Why `target` must not post live right now, or null when it may.
 *
 * 1. A regular entry whose LATER month already posted: that later close trued the cumulative
 *    balance, absorbing this one. Posting it would book the adjustment twice.
 * 2. An earlier month posted after this draft was generated: the draft was computed against
 *    a book that no longer exists.
 * 3. An earlier month still has an unposted correction draft.
 */
export function postOrderReason(target: CloseHeaderRef, all: readonly CloseHeaderRef[]): string | null {
  const peers = all.filter((h) => h.entity === target.entity && h.id !== target.id);

  if (!isCorrection(target)) {
    const later = peers.filter((h) => h.month > target.month && h.status === 'posted');
    if (later.length > 0) {
      return (
        `${label(target)} is out of date: ${label(later[0])} has already posted and its close ` +
        `already covers ${target.month}. Posting this would book it twice. Discard this draft instead.`
      );
    }
  }

  const generated = time(target.generatedAt);
  const postedSince = peers.filter(
    (h) =>
      h.month < target.month &&
      h.status === 'posted' &&
      h.postedAt !== null &&
      (Number.isNaN(generated) || time(h.postedAt) > generated),
  );
  if (postedSince.length > 0) {
    const names = postedSince.map(label).join(', ');
    return `${label(target)} is stale: ${names} posted after it was generated. Regenerate it before posting.`;
  }

  const openEarlier = peers.filter((h) => h.month < target.month && isCorrection(h) && h.status !== 'posted');
  if (openEarlier.length > 0) {
    return `Post or discard ${openEarlier.map(label).join(', ')} first; earlier months post before later ones.`;
  }
  return null;
}

/** One posted month's current gap, as the drift check measured it. */
export interface MonthGap {
  month: string;
  /** Σ category (FIFO − book) now. */
  gap: number;
}

/**
 * Why a correction for (entity, month) must not be generated yet, or null when it may.
 * `earlierGaps` are the entity's posted months before `month`.
 */
export function correctionOrderReason(
  entity: string,
  month: string,
  headers: readonly CloseHeaderRef[],
  earlierGaps: readonly MonthGap[],
): string | null {
  const openEarlier = headers.filter(
    (h) => h.entity === entity && h.month < month && isCorrection(h) && h.status !== 'posted',
  );
  if (openEarlier.length > 0) {
    return `${entity}: post or discard ${openEarlier.map(label).join(', ')} before correcting ${month}.`;
  }
  const gapped = [...earlierGaps]
    .filter((g) => g.month < month && Math.abs(g.gap) >= DRIFT_TOLERANCE)
    .sort((a, b) => a.month.localeCompare(b.month));
  if (gapped.length > 0) {
    const g = gapped[0];
    return (
      `${entity}: correct ${g.month} first (gap ${g.gap.toFixed(2)}). Month-end balances carry forward, ` +
      `so a ${month} correction generated now would also book ${g.month}'s gap, and it would count twice once ${g.month} is corrected.`
    );
  }
  return null;
}

export type DriftStatus = 'ties' | 'correct' | 'after' | 'open';

/**
 * Status per posted month for one entity, oldest first. Only the EARLIEST gapped month gets
 * `correct`; every later gapped month waits (`after`), because correcting the earlier one
 * changes its balance too.
 */
export function driftStatuses(
  months: ReadonlyArray<{ month: string; gap: number; openCorrection: boolean }>,
): Map<string, DriftStatus> {
  const out = new Map<string, DriftStatus>();
  let blocked = false;
  for (const m of [...months].sort((a, b) => a.month.localeCompare(b.month))) {
    if (m.openCorrection) {
      out.set(m.month, 'open');
      blocked = true;
    } else if (Math.abs(m.gap) < DRIFT_TOLERANCE) {
      out.set(m.month, 'ties');
    } else if (blocked) {
      out.set(m.month, 'after');
    } else {
      out.set(m.month, 'correct');
      blocked = true;
    }
  }
  return out;
}

/** Whole days from a month's last day to `todayIso`. */
export function daysSinceMonthEnd(month: string, todayIso: string): number {
  const [y, m] = month.split('-').map(Number);
  const end = Date.UTC(y, m, 0);
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  return Math.floor((today - end) / 86_400_000);
}

/** The early-post warning, or null once the month has had SETTLE_DAYS to settle. */
export function earlyPostWarning(month: string, todayIso: string): string | null {
  const days = daysSinceMonthEnd(month, todayIso);
  if (days >= SETTLE_DAYS) return null;
  return (
    `${month} ended ${days} day${days === 1 ? '' : 's'} ago. Bills for it are still being keyed ` +
    `(about 93% are in by day ${SETTLE_DAYS}), and every one keyed after this posts puts inventory back ` +
    'above FIFO. Posting now is fine; run the drift check and correct once the month has settled.'
  );
}
