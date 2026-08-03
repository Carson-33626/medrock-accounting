// web/scripts/receipt-capture/cli-args.ts
// Shared CLI-flag parsing for the receipt-capture runners.

// The earliest period receipt capture may write to. Attaching a receipt or patching a split on an
// older txn RE-OPENS a closed accounting period — a bookkeeping problem no amount of correct
// matching makes acceptable. This is a hard refusal, not a clamp: an operator who passes an
// earlier --since gets an error explaining why, rather than a run that silently works on a
// narrower window than they asked for.
//
// ADVANCE THIS as accounting closes months. Set to 2026-05-01 on 2026-08-03: Carson confirmed the
// team is working the MAY close, so Jan-Apr 2026 are shut. It cost 3 matched ULINE txns (2 Feb,
// 1 Mar) to raise it from 2026-01-01, which is the right trade against re-opening a closed month.
export const PERIOD_FLOOR = '2026-05-01';

export function resolveSince(raw: string | null): string {
  if (raw === null) return PERIOD_FLOOR;
  const since = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error(`--since must be YYYY-MM-DD, got "${raw}"`);
  }
  if (since < PERIOD_FLOOR) {
    throw new Error(
      `--since ${since} is before the ${PERIOD_FLOOR} period floor — writing to those txns re-opens a closed period. Pass ${PERIOD_FLOOR} or later.`,
    );
  }
  return since;
}

// An explicit `--limit 0` must be respected (zero live writes), not collapsed to the default —
// `Number(raw ?? '5') || 5` treats 0 as falsy and silently substitutes 5, which on a --live run
// means writes the operator explicitly tried to suppress. Only absence of the flag or a
// non-numeric value falls back to `def`; negative values are clamped/rejected per `negativePolicy`.
export function parseNumericFlag(flagName: string, raw: string | null, def: number, negativePolicy: 'clamp' | 'reject'): number {
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  if (n < 0) {
    if (negativePolicy === 'reject') throw new Error(`${flagName} must be >= 0, got ${raw}`);
    return 0;
  }
  return n;
}
