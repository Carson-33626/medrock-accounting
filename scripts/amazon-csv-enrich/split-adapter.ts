// Adapt a grouped Amazon charge into the ParsedReceipt shape buildSplit consumes. Amazon's CSV already
// allocates tax + shipping into each Item Net Total, so order-level tax/shipping/tip are 0 here and the
// line amounts ARE the per-item net totals. The reconcile gate (charge.itemsTotalCents === txn amount)
// lives in the caller (run-split), same as the amazon-enrich and walmart-enrich pipelines; this adapter
// only maps, and faithfully carries parsedTotalCents = itemsTotalCents so the caller can detect a
// partial-fulfillment mismatch and defer it.
import type { ParsedReceipt } from '../amazon-enrich/receipt-parser';
import type { AmazonCharge } from './types';

export function chargeToParsed(charge: AmazonCharge): ParsedReceipt {
  return {
    layout: 'AMZ',
    source: 'amazon-csv',
    order: charge.primaryOrderId,
    glHint: null,
    items: charge.items.map((it) => ({ desc: it.desc, amountCents: it.amountCents })),
    taxCents: 0,
    shippingCents: 0,
    tipCents: 0,
    parsedTotalCents: charge.itemsTotalCents,
  };
}
