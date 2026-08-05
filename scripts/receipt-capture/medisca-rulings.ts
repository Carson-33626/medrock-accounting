// Human rulings on Medisca items the history classifier refuses.
//
// These are DECISIONS, not inferences. Everything in medisca-gl.ts replays what the accountant has
// already done; this file records what a human decided when her history could not answer. Each entry
// carries who ruled, when, and the evidence they ruled on, so the choice is auditable a year from now.
//
// A ruling only ever fires AFTER classification refuses. It can never override a confident history
// match — if she starts coding one of these items consistently some other way, her own history wins
// and the ruling goes dead. That ordering is enforced in planMediscaEnrichment.
import { normalizeItem } from './medisca-gl';

export const RULED_BY = 'Carson D. 2026-08-05';

export interface ItemRuling {
  /** the memo text as it appears on Ramp; the lookup key is normalizeItem() of this */
  sample: string;
  account: string;
  rationale: string;
}

/**
 * A ruling for one specific draft line. Needed only where the line carries NO memo at all, so there
 * is no item to key on. The amount is a guard: if the draft is edited underneath us the ruling stops
 * applying rather than silently landing on some other line.
 */
export interface LineRuling {
  draftId: string;
  lineIndex: number;
  amountCents: number;
  account: string;
  rationale: string;
}

// Carson's calls, 2026-08-05, on the 10 drafts the first dry-run refused.
export const ITEM_RULINGS: ItemRuling[] = [
  {
    sample: 'Bimatoprost (Frozen)',
    account: '1220.10',
    rationale:
      'Compound ingredient. The frozen form had no history of its own, but the plain form is coded ' +
      '1220.10 forty times out of forty-two. Blocked only because our containment matcher skips ' +
      'candidate keys under 12 chars and "bimatoprost" is 11.',
  },
  {
    sample: 'Tranexamic Acid, USP',
    account: '1220.10',
    rationale:
      'Compound ingredient. History is 7x 1220.10 / 1x 1220.05 = 87.5%, just under the gate; the ' +
      'lone 1220.05 is a one-off from 2025-05-30 and the five most recent codings are all 1220.10.',
  },
  {
    sample: 'Estradiol, USP (Hemihydrate) (Micronized)',
    account: '1220.10',
    rationale:
      'Compound ingredient. Exact history is 2x 1220.10 / 1x 1220.05, and the 1220.05 is the OLDEST ' +
      '(2025-04-07). The sibling item "Estradiol, USP (Hemihydrate)" is 2x 1220.10 as of 2026-02.',
  },
  {
    sample: 'Dispenser, MD Syringe Airless 10mL, 0.15mL, w/view window',
    account: '1220.15',
    rationale:
      'Compounding packaging. History is 25x 1220.15 / 3x 1220.10 / 1x 1220.20 = 86.2%, under the ' +
      'gate, but every one of the last 21 codings since 2025-06-16 is 1220.15. The minority entries ' +
      'are all from early 2025 before she settled.',
  },
  {
    sample: 'Stir-Bar Positioner/Retriever 12"',
    account: '1220.20',
    rationale:
      'Lab supplies inventory, not lab expense. No history for this item at all, but the nearest ' +
      'precedent is near-exact: "Stirring Rod, Glass, 12"" ($33) and "Stirring Rods, Glass, 7 3/4"" ' +
      '($22) both went to 1220.20 on 2026-03-18. 6200.75 Non-Capital Lab Equipment is reserved for ' +
      'Samix machine parts (jars, blades, pump adapters), which this is not.',
  },
];

export const LINE_RULINGS: LineRuling[] = [
  {
    // TN invoice 04233232 — three $60 glove lines (S, M, L). Ramp dropped the memo on the third.
    draftId: '79112039-3243-48e2-9d69-ff6e7a373dd8',
    lineIndex: 2,
    amountCents: 6000,
    account: '1220.20',
    rationale:
      'Lab supplies inventory. The line memo is null, but the attached invoice reads S/M/L gloves at ' +
      '$60 each and the other two lines are already the S and M. All 16 glove lines in her history ' +
      'are 1220.20, without exception.',
  },
];

export interface MediscaRulings {
  byItem: Map<string, ItemRuling>;
  byLine: Map<string, LineRuling>;
}

export function lineRulingKey(draftId: string, lineIndex: number): string {
  return `${draftId}:${lineIndex}`;
}

/**
 * Keys are derived by running the sample memo through normalizeItem rather than being hardcoded, so
 * a change to normalisation carries the rulings with it instead of silently orphaning them.
 */
export function buildRulings(
  items: ItemRuling[] = ITEM_RULINGS,
  lines: LineRuling[] = LINE_RULINGS,
): MediscaRulings {
  const byItem = new Map<string, ItemRuling>();
  for (const r of items) {
    const key = normalizeItem(r.sample);
    if (key === '') throw new Error(`Ruling sample normalises to empty: ${JSON.stringify(r.sample)}`);
    const prior = byItem.get(key);
    if (prior && prior.account !== r.account) {
      throw new Error(`Conflicting rulings for "${key}": ${prior.account} vs ${r.account}`);
    }
    byItem.set(key, r);
  }
  const byLine = new Map<string, LineRuling>();
  for (const r of lines) byLine.set(lineRulingKey(r.draftId, r.lineIndex), r);
  return { byItem, byLine };
}
