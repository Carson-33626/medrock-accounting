// Learn SKU -> GL account from the overlap between the Medisca portal and QuickBooks.
//
// WHY THIS EXISTS. medisca-gl.ts replays the accountant's QuickBooks DESCRIPTIONS, and scores 77/77
// on enrich because Ramp's drafts carry the same prose she coded. Create mode does not: the portal
// speaks a different language for the same item.
//
//   QB / Ramp draft : Gloves, Blue Nitrile Powder-Free, (S - 9"- 4 mil) (Non-Sterile) Safe-Sense
//   invoice PDF     : Gloves, Blue Nitrile Powder-Free,          <- truncated
//   order page      : Nitrile Gloves 9" 4mil                     <- different wording entirely
//
// So a description classifier would largely MISS on create, not because the logic is wrong but
// because it is reading different words for the same product. A SKU is product identity, and she
// codes a product consistently, so the SKU is the better join key. Measured over the portal/QB
// overlap: 47 distinct SKUs, 47 mapping to exactly one account.
//
// This is still replaying HER coding — nothing here invents an account.
export type SkuHistory = Map<string, Map<string, number>>;

export interface SkuObservation {
  sku: string;
  account: string;
}

export function recordSku(history: SkuHistory, sku: string, account: string): void {
  if (sku === '' || account === '') return;
  const inner = history.get(sku) ?? new Map<string, number>();
  inner.set(account, (inner.get(account) ?? 0) + 1);
  history.set(sku, inner);
}

export interface SkuVerdict {
  account: string | null;
  reason: string;
}

/**
 * A SKU resolves only when EVERY observation agrees. Deliberately stricter than the description
 * classifier's 90% gate: descriptions are fuzzy and a stray mismatch is usually noise, whereas a SKU
 * is exact, so disagreement means the product genuinely gets coded two ways and is a judgement call.
 */
export function classifySku(sku: string, history: SkuHistory): SkuVerdict {
  const hit = history.get(sku);
  if (hit === undefined) return { account: null, reason: 'sku_unknown' };
  const entries = [...hit.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length > 1) {
    return { account: null, reason: `sku_ambiguous(${entries.map(([a, n]) => `${a}:${n}`).join(' ')})` };
  }
  return { account: entries[0][0], reason: `sku(${entries[0][1]})` };
}

export interface PortalLine {
  sku: string;
  amountCents: number;
}

export interface QbCodedLine {
  account: string;
  amountCents: number;
}

/**
 * Join one invoice's portal lines to its QuickBooks lines BY AMOUNT.
 *
 * Only amounts that are unique on BOTH sides are used. Two lines at the same price are genuinely
 * indistinguishable by amount — the three $120 glove lines are exactly this — and guessing there
 * would teach the map a wrong SKU, which becomes a wrong GL account on every future invoice. Losing
 * an observation costs nothing; a wrong one is permanent.
 */
export function joinInvoiceLines(portal: PortalLine[], qb: QbCodedLine[]): SkuObservation[] {
  const countBy = <T,>(rows: T[], amount: (r: T) => number): Map<number, number> => {
    const m = new Map<number, number>();
    for (const r of rows) m.set(amount(r), (m.get(amount(r)) ?? 0) + 1);
    return m;
  };
  const portalCounts = countBy(portal, (l) => l.amountCents);
  const qbCounts = countBy(qb, (l) => l.amountCents);

  const out: SkuObservation[] = [];
  for (const p of portal) {
    if (portalCounts.get(p.amountCents) !== 1) continue;
    if (qbCounts.get(p.amountCents) !== 1) continue;
    const match = qb.find((q) => q.amountCents === p.amountCents);
    if (match === undefined || match.account === '') continue;
    out.push({ sku: p.sku, account: match.account });
  }
  return out;
}

export function buildSkuHistory(observations: SkuObservation[]): SkuHistory {
  const history: SkuHistory = new Map();
  for (const o of observations) recordSku(history, o.sku, o.account);
  return history;
}

/** Persisted alongside the cache so a create run does not have to re-derive it from QuickBooks. */
export interface SkuMapFile {
  builtAt: string;
  /** sku -> account, only the unanimous ones */
  resolved: Record<string, string>;
  /** sku -> the competing accounts, kept so a human can see what needs a ruling */
  ambiguous: Record<string, string[]>;
}

export function toSkuMapFile(history: SkuHistory, builtAt: string): SkuMapFile {
  const resolved: Record<string, string> = {};
  const ambiguous: Record<string, string[]> = {};
  for (const [sku] of history) {
    const v = classifySku(sku, history);
    if (v.account !== null) resolved[sku] = v.account;
    else ambiguous[sku] = [...(history.get(sku) ?? new Map<string, number>()).keys()];
  }
  return { builtAt, resolved, ambiguous };
}

export function fromSkuMapFile(file: SkuMapFile): SkuHistory {
  const history: SkuHistory = new Map();
  for (const [sku, account] of Object.entries(file.resolved)) recordSku(history, sku, account);
  // Ambiguity must survive the round trip, or reloading a map would silently promote a contested
  // SKU to resolved on the next run.
  for (const [sku, accounts] of Object.entries(file.ambiguous)) {
    for (const a of accounts) recordSku(history, sku, a);
  }
  return history;
}
