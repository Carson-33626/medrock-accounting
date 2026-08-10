// GL coding for Letco invoices, mined from the accountant's own 516 lines across 213 bills:
//   product  -> 1220.10  Inventory Asset : Compound Ingredient Inventory   (328 lines, $617,545)
//   shipping -> 5000.45  COGS : Shipping & Handling - COGS Purchases       (180 lines, $2,806)
// 508 of 516 lines follow exactly that rule, so no classifier is used. The two rare accounts
// (1220.05, 1220.35) are deliberately NOT automated — they are judgement calls the accountant
// makes, and guessing them would be worse than leaving them to her.
import type { ParsedInvoice } from './letco-invoice';

export const LETCO_PRODUCT_ACCOUNT = '1220.10';
export const LETCO_SHIPPING_ACCOUNT = '5000.45';
export const SHIPPING_MEMO = 'Shipping & handling';

export interface CodedLine {
  amountCents: number;
  memo: string;
  account: string;
}

export function codeLetcoInvoice(parsed: ParsedInvoice): CodedLine[] {
  const coded: CodedLine[] = parsed.lines.map((l) => ({
    amountCents: l.amountCents,
    memo: l.description,
    account: LETCO_PRODUCT_ACCOUNT,
  }));
  if (parsed.shippingCents > 0) {
    coded.push({ amountCents: parsed.shippingCents, memo: SHIPPING_MEMO, account: LETCO_SHIPPING_ACCOUNT });
  }
  return coded;
}
