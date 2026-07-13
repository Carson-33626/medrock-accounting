// Build the itemized split from a ParsedReceipt: distribute tax+shipping+tip across item lines
// proportionally, absorb rounding on the last line so Σ line amounts == txn amount EXACTLY (Ramp
// requires it). Classify each line -> GL; below-threshold lines fall back to Suspense. Extracted from
// run.ts so both amazon-enrich and walmart-enrich share one implementation.
import { classify } from './classifier';
import { resolveGl } from './gl-resolve';
import type { GlIndex } from './gl-resolve';
import type { ParsedReceipt } from './receipt-parser';
import type { PatchLine } from './client';

export interface SplitLine extends PatchLine { desc: string; glName: string | null; confidence: number; coded: boolean }
export interface BuiltSplit { lines: SplitLine[]; codedCount: number; suspenseCount: number }

const DEFAULT_CONF_THRESHOLD = 0.8;

export function buildSplit(
  parsed: ParsedReceipt,
  txnAmountCents: number,
  index: GlIndex,
  confThreshold: number = DEFAULT_CONF_THRESHOLD,
): BuiltSplit | null {
  if (index.suspenseId === null) return null;
  const items = parsed.items;
  const itemsTotal = items.reduce((a, b) => a + b.amountCents, 0);
  if (itemsTotal <= 0) return null;
  const extra = parsed.taxCents + parsed.shippingCents + parsed.tipCents;
  const lines: SplitLine[] = [];
  let allocated = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const amount = i === items.length - 1
      ? txnAmountCents - allocated
      : it.amountCents + Math.round((extra * it.amountCents) / itemsTotal);
    allocated += amount;
    const c = classify(it.desc);
    const glId = c.confidence >= confThreshold ? resolveGl(index, c.glName, c.acctnum) : null;
    const coded = glId !== null;
    lines.push({
      amount,
      memo: it.desc.slice(0, 200),
      accounting_field_selections: [{ field_external_id: 'QuickbooksCategory', field_option_external_id: coded ? glId! : index.suspenseId }],
      desc: it.desc,
      glName: coded ? c.glName : 'Suspense',
      confidence: c.confidence,
      coded,
    });
  }
  const sum = lines.reduce((a, b) => a + b.amount, 0);
  if (sum !== txnAmountCents) return null;
  return { lines, codedCount: lines.filter((l) => l.coded).length, suspenseCount: lines.filter((l) => !l.coded).length };
}
