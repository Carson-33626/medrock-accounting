/**
 * CS catch-up support (Carson, 2026-08-25). Customer-Service labor for April–August 2026
 * was allocated by standalone posted `CS Allo 2026.MM` entries before the full month-end
 * process was ready. Two pure helpers keep that history and the automation from ever
 * moving the same dollars twice:
 *
 *  - excludeCsLines: the HARD RULE for the full month-end. For a month that has posted
 *    CS Allo entries, the EOM pool drops its Customer-Service slice — CS is already
 *    allocated, the automation handles everything else.
 *  - csRemainderLines: the delta for the catch-up itself. A re-run builds the full-month
 *    CS allocation fresh, nets out what the posted CS Allo entries already moved, and
 *    posts only the remainder (the August "more payroll landed after 8/25" top-up).
 *
 * Both are pure; the DB lookups live in eom-store (listPostedCsAlloHeaders) and the
 * runner script.
 */
import type { PoolLine } from './qb-pool';
import { isCsPoolLine } from './qb-pool';
import type { JournalLine } from './types';
import { remainderLines } from './eom-correction';

/** Split a month's pool into the CS slice and everything else. */
export function excludeCsLines(pool: PoolLine[]): { kept: PoolLine[]; cs: PoolLine[] } {
  const kept: PoolLine[] = [];
  const cs: PoolLine[] = [];
  for (const l of pool) (isCsPoolLine(l) ? cs : kept).push(l);
  return { kept, cs };
}

/**
 * Net already-posted CS Allo line sets out of a freshly built full-month target for ONE
 * entity, returning only the lines still needed. Keyed per account name (the IE legs
 * already encode their counterparty in the account name), signed Debit + / Credit −;
 * a remainder that flips sign flips posting side. Both inputs balance to zero signed
 * cents individually, so the remainder always balances too.
 */
export function csRemainderLines(target: JournalLine[], postedSets: JournalLine[][]): JournalLine[] {
  return remainderLines(target, postedSets, 'Customer Service allocation — top-up');
}
