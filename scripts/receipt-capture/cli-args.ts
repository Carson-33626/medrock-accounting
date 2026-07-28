// web/scripts/receipt-capture/cli-args.ts
// Shared CLI-flag parsing for the receipt-capture runners.

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
