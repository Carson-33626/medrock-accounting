// Enrich mode: GL-code the draft bills the bookkeeper has ALREADY created in Ramp.
//
// The pilot proved the create path was solving the wrong problem — Kristina enters every Letco
// invoice as a draft herself (25 of our 38 proposed creates already existed as her drafts), and the
// only thing missing from them is the GL coding she does by hand before sending for approval.
//
// Coding someone else's line items is riskier than coding our own parse, for two reasons, and this
// module exists to contain both:
//
//   1. Her line memos are HERS ("Trichosol", not the portal's "TrichoSol™"), so the product/shipping
//      split has to be read off free text. Free text alone is not good enough to post money on, so
//      every plan must clear a reconcile gate against the portal invoice — the authoritative source.
//      We never *infer* what a line is; we prove that our reading of her lines reproduces the
//      vendor's own totals.
//   2. Ramp's `PATCH /bills/drafts/{id}` REPLACES the entire line_items array. Any line, amount or
//      memo we fail to echo back is destroyed. So the plan carries her full line set verbatim and
//      adds nothing but the account.
import type { ParsedInvoice } from './letco-invoice';
import { LETCO_PRODUCT_ACCOUNT, LETCO_SHIPPING_ACCOUNT } from './letco-gl';
import type { CodedLine } from './letco-gl';

// One line as it currently stands on her draft in Ramp.
export interface DraftLine {
  amountCents: number;
  memo: string;
  /** true if this line already carries any accounting_field_selection */
  coded: boolean;
}

export type EnrichRefusal =
  | 'no_lines'
  | 'already_coded'
  | 'total_mismatch'
  | 'shipping_mismatch';

export type EnrichPlan =
  | { ok: true; lines: CodedLine[] }
  | { ok: false; reason: EnrichRefusal };

// Matches how the accountant labels freight across her own history and how Ramp's OCR renders it.
// Deliberately broad on wording but narrow in consequence: a false positive here cannot survive the
// shipping-residual gate below.
const FREIGHT = /shipping|freight|handling/i;

export function isFreightMemo(memo: string): boolean {
  return FREIGHT.test(memo);
}

export function planDraftEnrichment(draftLines: DraftLine[], parsed: ParsedInvoice): EnrichPlan {
  if (draftLines.length === 0) return { ok: false, reason: 'no_lines' };

  // Any coding at all means a human is mid-judgement on this bill. She uses 1220.05 and 1220.35 for
  // calls we deliberately do not automate, so "fill in the blanks" is not a safe operation.
  if (draftLines.some((l) => l.coded)) return { ok: false, reason: 'already_coded' };

  const total = draftLines.reduce((a, l) => a + l.amountCents, 0);
  if (total !== parsed.totalCents) return { ok: false, reason: 'total_mismatch' };

  const freight = draftLines.filter((l) => isFreightMemo(l.memo));
  const freightTotal = freight.reduce((a, l) => a + l.amountCents, 0);
  // The gate that makes this safe: what she called freight must equal what the vendor's own invoice
  // says freight was. A mislabelled or missed line fails here instead of quietly posting COGS to
  // inventory (or the reverse).
  if (freightTotal !== parsed.shippingCents) return { ok: false, reason: 'shipping_mismatch' };

  const lines: CodedLine[] = draftLines.map((l) => ({
    amountCents: l.amountCents,
    memo: l.memo,
    account: isFreightMemo(l.memo) ? LETCO_SHIPPING_ACCOUNT : LETCO_PRODUCT_ACCOUNT,
  }));
  return { ok: true, lines };
}
