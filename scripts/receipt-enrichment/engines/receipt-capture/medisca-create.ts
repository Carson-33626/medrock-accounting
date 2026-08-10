// Plan a Ramp draft bill from a cached Medisca invoice. Pure: no network, no writes.
//
// Three independent reads of one invoice have to agree before anything is proposed — the invoice
// LIST row, the invoice PDF, and the order detail page. They come from different endpoints and are
// rendered by different code, so agreement is real evidence rather than a self-consistent parse.
import { LETCO_SHIPPING_ACCOUNT } from './letco-gl';
import { classifyLine } from './medisca-gl';
import type { MediscaHistory } from './medisca-gl';
import { classifySku } from './medisca-sku';
import type { SkuHistory } from './medisca-sku';
import type { MediscaRulings } from './medisca-rulings';
import { normalizeItem } from './medisca-gl';
import type { OrderLine } from './medisca-order';
import type { ParsedInvoiceLine, ParsedInvoiceTotals } from './medisca-invoice';

export interface CreateInput {
  invoiceNumberRaw: string;
  /** from the invoice LIST row — an independent read of the total */
  listTotalCents: number;
  /** from the invoice PDF — authoritative for WHAT WAS BILLED */
  pdfLines: ParsedInvoiceLine[];
  pdfTotals: ParsedInvoiceTotals | null;
  /** from the order page — SKU and clean product names; may contain lines that were NOT billed */
  orderLines: OrderLine[];
}

export interface PlannedLine {
  amountCents: number;
  memo: string;
  /** null when this line could not be coded; a whole draft with any null goes out uncoded */
  account: string | null;
  reason: string;
  sku: string;
}

export type CreateRefusal =
  | 'zero_dollar'
  | 'no_lines'
  | 'no_totals'
  | 'total_mismatch'
  | 'lines_do_not_sum';

export type CreatePlan =
  | { ok: true; lines: PlannedLine[]; coded: boolean; adjustmentCents: number }
  | { ok: false; reason: CreateRefusal; detail: string };

export interface CreateContext {
  skuHistory: SkuHistory;
  descriptionHistory: MediscaHistory;
  rulings?: MediscaRulings;
}

/** Amount -> order line, keeping only amounts unique on BOTH sides so a SKU is never guessed. */
function indexOrderLines(pdfLines: ParsedInvoiceLine[], orderLines: OrderLine[]): Map<number, OrderLine> {
  const count = <T,>(rows: T[], amount: (r: T) => number): Map<number, number> => {
    const m = new Map<number, number>();
    for (const r of rows) m.set(amount(r), (m.get(amount(r)) ?? 0) + 1);
    return m;
  };
  const pdfCounts = count(pdfLines, (l) => l.amountCents);
  const orderCounts = count(orderLines, (l) => l.amountCents);

  const out = new Map<number, OrderLine>();
  for (const o of orderLines) {
    if (orderCounts.get(o.amountCents) !== 1) continue;
    if (pdfCounts.get(o.amountCents) !== 1) continue;
    out.set(o.amountCents, o);
  }
  return out;
}

/**
 * SKU first, then her description history, then a human ruling. Each step is her own coding replayed
 * through a different key; nothing here invents an account.
 */
function codeLine(memo: string, sku: string, ctx: CreateContext): { account: string | null; reason: string } {
  if (sku !== '') {
    const v = classifySku(sku, ctx.skuHistory);
    if (v.account !== null) return v;
  }
  const byDescription = classifyLine(memo, ctx.descriptionHistory);
  if (byDescription.account !== null) return byDescription;

  const ruling = ctx.rulings?.byItem.get(normalizeItem(memo));
  if (ruling !== undefined) return { account: ruling.account, reason: 'item_ruling' };

  return { account: null, reason: sku === '' ? byDescription.reason : `sku_unknown+${byDescription.reason}` };
}

export function planMediscaCreate(input: CreateInput, ctx: CreateContext): CreatePlan {
  // A $0 invoice is a free-goods document. The books record those at $0 with no offsetting pair
  // anywhere in 2,170 bills, and the intended cost-then-credit treatment is unsettled, so we report
  // rather than invent lines the vendor's document does not carry.
  if (input.listTotalCents === 0) {
    return { ok: false, reason: 'zero_dollar', detail: 'free-goods invoice; treatment not settled' };
  }

  // ORDER-PAGE FALLBACK for image-only PDFs. Every Medisca invoice before 2026-08-03 is a scan with
  // no text layer, so an unparseable PDF is the NORMAL state of the historical backlog, not an edge
  // case. The order page still has the lines — but an order is not an invoice (back-orders bill
  // later), so it may only stand in when Σ(order lines) equals the invoice total EXACTLY: that
  // equality is only true when the order shipped complete, and it is precisely the reconcile gate
  // the PDF path enforces. A partially-billed order fails the sum and stays refused.
  if (input.pdfLines.length === 0) {
    const orderSum = input.orderLines.reduce((a, l) => a + l.amountCents, 0);
    if (input.orderLines.length > 0 && orderSum === input.listTotalCents) {
      return planFromLines(
        input.orderLines.map((o) => ({ amountCents: o.amountCents, unitPriceCents: o.unitPriceCents, text: o.name })),
        input, ctx,
      );
    }
    return {
      ok: false,
      reason: 'no_lines',
      detail: input.orderLines.length === 0
        ? 'no billed lines parsed from the invoice PDF and no order lines'
        : `image-only PDF and order lines sum ${orderSum} != invoice total ${input.listTotalCents} (partially billed order)`,
    };
  }
  if (input.pdfTotals === null) {
    return { ok: false, reason: 'no_totals', detail: 'could not read the PDF totals block' };
  }

  // Gate 1 — two independent reads of the total. Catches a mis-parsed total either side.
  if (input.pdfTotals.totalCents !== input.listTotalCents) {
    return {
      ok: false,
      reason: 'total_mismatch',
      detail: `PDF total ${input.pdfTotals.totalCents} != list total ${input.listTotalCents}`,
    };
  }

  // Gate 2 — the billed lines must account for either anchor of the totals block, because Medisca
  // uses TWO conventions and they disagree about which one the lines tie to:
  //
  //   SHIPPING  (invoice 04245590): lines 360.00 == SUB-TOTAL; a -10.00 shipping charge appears only
  //             in the totals block, so the lines are GROSS and total is 350.00.
  //   DISCOUNT  (invoice 04245602): lines 321.30 == TOTAL; SUB-TOTAL 357.00 is the undiscounted list
  //             price and the 10% is already baked into every line AMOUNT.
  //
  // Requiring the subtotal alone rejected every discounted invoice; requiring the total alone would
  // reject every one carrying shipping. Accepting either still catches the failure that matters — a
  // dropped or duplicated line matches neither anchor.
  const linesSum = input.pdfLines.reduce((a, l) => a + l.amountCents, 0);
  if (linesSum !== input.pdfTotals.subtotalCents && linesSum !== input.pdfTotals.totalCents) {
    return {
      ok: false,
      reason: 'lines_do_not_sum',
      detail: `lines ${linesSum} matches neither PDF subtotal ${input.pdfTotals.subtotalCents} nor total ${input.pdfTotals.totalCents}`,
    };
  }

  return planFromLines(input.pdfLines, input, ctx);
}

function planFromLines(
  billed: ParsedInvoiceLine[],
  input: CreateInput,
  ctx: CreateContext,
): CreatePlan {
  const bySku = indexOrderLines(billed, input.orderLines);
  const lines: PlannedLine[] = billed.map((l) => {
    const order = bySku.get(l.amountCents);
    // Prefer the order page's product name: the PDF's is lossy (it drops "Safe-Sense", "Non-Sterile"
    // and "4 mil" on invoice 04245590). Fall back to the PDF text when there is no clean join.
    const memo = order ? [order.name, order.lot].filter((s) => s !== '').join(' Lot:') : l.text;
    const sku = order?.sku ?? '';
    const coded = codeLine(order?.name ?? l.text, sku, ctx);
    return { amountCents: l.amountCents, memo, account: coded.account, reason: coded.reason, sku };
  });

  // Shipping/discount is derived by subtraction rather than read positionally: the PDF's totals block
  // omits its zero columns ("$360.00 $0.00 ($10.00) $350.00" is four values under five headers), so
  // the difference is the only exact route to it.
  const linesSum = billed.reduce((a, l) => a + l.amountCents, 0);
  const adjustmentCents = input.listTotalCents - linesSum;
  if (adjustmentCents !== 0) {
    lines.push({
      amountCents: adjustmentCents,
      memo: adjustmentCents < 0 ? 'Shipping & handling credit' : 'Shipping & handling',
      account: LETCO_SHIPPING_ACCOUNT,
      reason: 'derived_adjustment',
      sku: '',
    });
  }

  // Fully coded or not coded at all. A partially coded draft looks reviewed when it is not — the
  // same reasoning that makes enrich mode all-or-nothing. Uncoded is honest; half-coded misleads.
  const coded = lines.every((l) => l.account !== null);
  return { ok: true, lines, coded, adjustmentCents };
}
