import type { EntityMethodScore, ForecastMethod } from "./types";

export interface MethodRanking {
  method: ForecastMethod;
  wape: number | null;   // avg error %, null when untrainable or no hold-out
  trainable: boolean;
  recommended: boolean;
}

/** Tie-break preference: earlier wins when WAPE ties. */
const TIE_ORDER: ForecastMethod[] = ['holt-winters', 'weighted-avg', 'linear-trend', 'ses', 'seasonal-naive'];

interface Agg { abs: number; act: number; holdout: number; trainable: boolean; }

/**
 * Aggregate per-entity score components over the shown selection into a WAPE per method,
 * then flag the lowest as recommended. WAPE = Σ|a−f| ÷ Σa (volume-weighted). An empty
 * `shown` set means "all entities" (matches the report's client-side filter convention).
 */
export function rankMethods(scores: EntityMethodScore[], shown: Set<string>): MethodRanking[] {
  const agg = new Map<ForecastMethod, Agg>();
  const get = (m: ForecastMethod): Agg => {
    let a = agg.get(m);
    if (!a) { a = { abs: 0, act: 0, holdout: 0, trainable: false }; agg.set(m, a); }
    return a;
  };
  for (const s of scores) {
    if (shown.size && !shown.has(s.entity)) continue;
    const a = get(s.method);
    if (s.trainable) {
      a.abs += s.absErrSum; a.act += s.actualSum; a.holdout += s.holdoutMonths; a.trainable = true;
    }
  }

  const rankings: MethodRanking[] = TIE_ORDER.map(method => {
    const a = agg.get(method);
    const scored = !!a && a.trainable && a.holdout > 0 && a.act > 0;
    return {
      method,
      wape: scored ? (a!.abs / a!.act) * 100 : null,
      trainable: scored,
      recommended: false,
    };
  });

  let best: MethodRanking | null = null;
  for (const r of rankings) {                 // rankings already in preference order
    if (r.wape === null) continue;
    if (!best || r.wape < best.wape!) best = r; // strict < keeps the higher-priority method on a tie
  }
  if (best) best.recommended = true;
  return rankings;
}

/** Backtest accuracy % from WAPE (which is an error rate). Higher = better; clamped at 0. */
export function accuracyPct(wape: number): number {
  return Math.max(0, 100 - wape);
}

/**
 * Dropdown suffix for a method, shown as ACCURACY (higher = better). `anyScored` = does any
 * method have a score (i.e. a hold-out exists). No hold-out → "" (clean name); hold-out but
 * this method untrainable → " · n/a".
 */
export function accuracyLabel(r: MethodRanking, anyScored: boolean): string {
  if (r.wape !== null) return ` · ${accuracyPct(r.wape).toFixed(1)}% acc${r.recommended ? " ✓" : ""}`;
  return anyScored ? " · n/a" : "";
}
