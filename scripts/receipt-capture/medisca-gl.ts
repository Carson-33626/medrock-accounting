// Medisca GL classification — see docs/superpowers/specs/2026-08-04-medisca-draft-enrichment-design.md
//
// Letco's rule was hardcoded because 508 of 516 of the accountant's lines fit one of two accounts.
// Medisca does NOT work that way: its top two accounts cover only 85.8%, because Medisca sells
// compounding ingredients AND lab equipment (6200.75) AND lab supplies (1220.20) AND packaging
// (1220.15) AND capital equipment (1500.02 — $59,618 of Samix mixers). Defaulting to 1220.10 would
// mis-post about one line in seven and would capitalise a $4,300 mixer as inventory.
//
// So nothing here invents a rule. We replay the accountant's OWN coding: a description -> account
// map mined from her QuickBooks history, applied only where she has been consistent. An item she
// has never coded, or has coded inconsistently, is refused and left for her.
import { LETCO_SHIPPING_ACCOUNT } from './letco-gl';

/** account code -> how many times she coded this description to it */
export type MediscaHistory = Map<string, Map<string, number>>;

export interface MediscaDraftLine {
  amountCents: number;
  memo: string;
  /** true if this line already carries a GL_ACCOUNT selection (see isGlCoded in bill-draft.ts) */
  coded: boolean;
}

export interface MediscaCodedLine {
  amountCents: number;
  memo: string;
  account: string;
}

export type MediscaRefusal =
  | 'no_lines'
  | 'already_coded'
  | 'unclassifiable';

export type MediscaPlan =
  | { ok: true; lines: MediscaCodedLine[] }
  | { ok: false; reason: MediscaRefusal; detail: string };

// Freight is the one thing safe to key off wording alone: it is never an inventory item, and the
// accountant codes all of it to the same account (94 lines in 2026). "hazmat" is included because
// Medisca bills hazardous-material shipping as its own charge.
const FREIGHT_RE = /shipping|freight|handling|hazmat/i;

// Her history must AGREE with itself this strongly before we replay it. Deliberately strict: at
// 0.9, "Dispenser, MD Syringe" (1220.15 x25, 1220.10 x3, 1220.20 x1 = 86.2%) is refused rather
// than guessed, which is the behaviour we want — that item genuinely is a judgement call.
export const MIN_CONFIDENCE = 0.9;

// QB descriptions carry lot/expiry/qty tails the Ramp memo does not:
//   "Ascorbic Acid USP/EP:227724/A Exp:01/31/30 Qty:5"  ->  "ascorbic acid usp ep"
// Truncate at the FIRST such marker. Stripping the patterns individually leaves a dangling "Lot"
// token behind ("Itraconazole, USP Lot"), which silently cost 8 real matches on the first pass.
export function normalizeItem(desc: string): string {
  let s = desc.trim();
  const cut = s.search(/\b(lot|exp|qty)\b\s*:|:\s*\d{5,}\/[A-Z]/i);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/[*]+/g, ' ');
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function recordHistory(history: MediscaHistory, description: string, accountCode: string): void {
  const key = normalizeItem(description);
  if (key === '' || accountCode === '') return;
  const inner = history.get(key) ?? new Map<string, number>();
  inner.set(accountCode, (inner.get(accountCode) ?? 0) + 1);
  history.set(key, inner);
}

export interface LineVerdict {
  account: string | null;
  /** why — carried into the plan CSV so a refusal is explainable without re-running */
  reason: string;
}

function decide(hit: Map<string, number>, via: string): LineVerdict {
  const sorted = [...hit.entries()].sort((a, b) => b[1] - a[1]);
  const total = [...hit.values()].reduce((a, n) => a + n, 0);
  const [topAccount, topCount] = sorted[0];
  if (topCount / total < MIN_CONFIDENCE) {
    return { account: null, reason: `ambiguous(${sorted.map(([a, n]) => `${a}:${n}`).join(' ')})` };
  }
  return { account: topAccount, reason: `${via}(${topCount}/${total})` };
}

export function classifyLine(memo: string, history: MediscaHistory): LineVerdict {
  if (FREIGHT_RE.test(memo)) return { account: LETCO_SHIPPING_ACCOUNT, reason: 'freight_memo' };
  const key = normalizeItem(memo);
  if (key === '') return { account: null, reason: 'empty_memo' };

  const exact = history.get(key);
  if (exact !== undefined) return decide(exact, 'history');

  // Ramp's memo and QB's description are the same item typed twice ("Boat, Anti-Static, 3.5 x 3.5"
  // vs "Weigh Boat, Anti-Static, 3.5 x 3.5"). A containment match recovers those, but only when
  // every candidate agrees on the account — otherwise we cannot tell which item she meant.
  const candidates = [...history.keys()].filter((k) => k.length >= 12 && (k.includes(key) || key.includes(k)));
  if (candidates.length === 0) return { account: null, reason: 'no_history' };
  const accounts = new Set(candidates.flatMap((k) => [...(history.get(k) ?? new Map<string, number>()).keys()]));
  if (accounts.size > 1) return { account: null, reason: `fuzzy_ambiguous(${[...accounts].join(' ')})` };
  return decide(history.get(candidates[0]) as Map<string, number>, 'fuzzy');
}

export function planMediscaEnrichment(lines: MediscaDraftLine[], history: MediscaHistory): MediscaPlan {
  if (lines.length === 0) return { ok: false, reason: 'no_lines', detail: 'draft has no line items' };
  // Any GL coding at all means she is mid-judgement on this bill — 1220.05 vs 1220.10 and the
  // 1500.02 capitalisation calls are hers. "Fill in the blanks" is not a safe operation.
  if (lines.some((l) => l.coded)) return { ok: false, reason: 'already_coded', detail: 'a line already carries a GL account' };

  const coded: MediscaCodedLine[] = [];
  const refusals: string[] = [];
  for (const l of lines) {
    const v = classifyLine(l.memo, history);
    if (v.account === null) {
      refusals.push(`"${l.memo.slice(0, 40)}" -> ${v.reason}`);
      continue;
    }
    coded.push({ amountCents: l.amountCents, memo: l.memo, account: v.account });
  }
  // All-or-nothing: a partially coded draft looks reviewed when it is not.
  if (refusals.length > 0) return { ok: false, reason: 'unclassifiable', detail: refusals.join(' | ') };
  return { ok: true, lines: coded };
}
