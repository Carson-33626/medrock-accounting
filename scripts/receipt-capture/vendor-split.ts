// buildSplit variant with vendor-rule-first GL coding. Allocation semantics IDENTICAL to
// amazon-enrich/split.ts: distribute tax+shipping proportionally over item lines, absorb
// rounding on the last line, refuse to return a split that does not sum EXACTLY.
import { classify } from '../amazon-enrich/classifier';
import { resolveGl } from '../amazon-enrich/gl-resolve';
import type { GlIndex } from '../amazon-enrich/gl-resolve';
import type { ParsedReceipt } from '../amazon-enrich/receipt-parser';
import type { Vendor } from './worklist';
import { vendorGl } from './gl-defaults';

export interface VendorItem { desc: string; amountCents: number; category: string | null }
export interface VendorParsed extends Omit<ParsedReceipt, 'items'> { items: VendorItem[] }
export interface VendorSplitLine {
  amount: number;
  memo: string | null;
  accounting_field_selections: { field_external_id: string; field_option_external_id: string }[];
  desc: string;
  glName: string | null;
  coded: boolean;
}
export interface BuiltVendorSplit { lines: VendorSplitLine[]; codedCount: number; suspenseCount: number }

const CONF_THRESHOLD = 0.8;

export function buildVendorSplit(
  vendor: Vendor,
  parsed: VendorParsed,
  txnAmountCents: number,
  index: GlIndex,
): BuiltVendorSplit | null {
  if (index.suspenseId === null) return null;
  const items = parsed.items.filter((i) => i.amountCents !== 0); // drop Free Offers $0 lines
  const itemsTotal = items.reduce((a, b) => a + b.amountCents, 0);
  if (itemsTotal <= 0) return null;
  const extra = parsed.taxCents + parsed.shippingCents + parsed.tipCents;
  const lines: VendorSplitLine[] = [];
  let allocated = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const amount = i === items.length - 1
      ? txnAmountCents - allocated
      : it.amountCents + Math.round((extra * it.amountCents) / itemsTotal);
    allocated += amount;
    let glId: string | null = null;
    let glName: string | null = null;
    const rule = vendorGl(vendor, it.category, it.desc);
    if (rule !== null) {
      glId = resolveGl(index, rule.glName, rule.acctnum);
      glName = rule.glName;
    }
    if (glId === null) {
      const c = classify(it.desc);
      if (c.confidence >= CONF_THRESHOLD) {
        glId = resolveGl(index, c.glName, c.acctnum);
        glName = c.glName;
      }
    }
    const coded = glId !== null;
    lines.push({
      amount,
      memo: it.desc.slice(0, 200),
      accounting_field_selections: [{ field_external_id: 'QuickbooksCategory', field_option_external_id: coded ? glId! : index.suspenseId }],
      desc: it.desc,
      glName: coded ? glName : 'Suspense',
      coded,
    });
  }
  const sum = lines.reduce((a, b) => a + b.amount, 0);
  if (sum !== txnAmountCents) return null;
  return { lines, codedCount: lines.filter((l) => l.coded).length, suspenseCount: lines.filter((l) => !l.coded).length };
}
