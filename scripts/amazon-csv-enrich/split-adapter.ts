// Adapt a grouped Amazon charge into the ParsedReceipt shape buildSplit consumes. Amazon's CSV already
// allocates tax + shipping into each Item Net Total, so order-level tax/shipping/tip are 0 here; the
// buildSplit reconcile gate (Σ lines == charge) then validates and defers partial-fulfillment charges.
import type { ParsedReceipt } from '../amazon-enrich/receipt-parser';
import type { AmazonCharge } from './types';

export function chargeToParsed(charge: AmazonCharge): ParsedReceipt {
  return {
    layout: 'OCR',            // reuse an existing allowed literal; provenance tracked via `source`
    source: 'walmart',        // nearest existing 'generated from structured data' source tag
    order: charge.primaryOrderId,
    glHint: null,
    items: charge.items.map((it) => ({ desc: it.desc, amountCents: it.amountCents })),
    taxCents: 0,
    shippingCents: 0,
    tipCents: 0,
    parsedTotalCents: charge.itemsTotalCents,
  };
}
