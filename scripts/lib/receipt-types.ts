// Copied declarations: the receipt-enrichment program owns the originals
// (engines/amazon-enrich/receipt-parser.ts for ParsedReceipt/ParsedItem, engines/amazon-enrich/client.ts
// for OcrData). Duplicated here so the web-side scripts (ramp-memo-fill.ts, ramp-memo-gap-probe.ts) never
// pull receipt-parser.ts — and therefore its pdf-parse import — into the root TypeScript program.
//
// The program moved to the repo root (a separate git repo) on 2026-08-10. The `item_gl_lookup.csv`
// and `item_corrections.json` byte-identical checks in receipt-copies.test.ts, and the parseOcr/
// classify drift checks that depended on these declarations, were removed with the move (web/ can
// no longer import the program to compare against). These declarations, and the data/ files below
// them, can now silently drift from the program's originals — nothing here catches it.
export interface ParsedItem {
  desc: string;
  amountCents: number; // pre-tax line amount
}
export interface ParsedReceipt {
  layout: 'A' | 'B' | 'OCR' | 'WMT' | 'AMZ' | null;
  source: 'ocr' | 'pdf' | 'walmart' | 'sams' | 'amazon-csv' | null; // which engine produced this
  order: string | null;
  glHint: string | null; // "GL code: X" embedded on the receipt (order-level hint)
  items: ParsedItem[];
  taxCents: number;
  shippingCents: number;
  tipCents: number; // driver tip etc. — distributed like tax; 0 for Amazon
  parsedTotalCents: number; // Σ item + tax + shipping
}

export interface OcrLine {
  item_name: string | null;
  item_quantity: number | null;
  item_unit_price: number | null;
  item_total_price: number | null;
  item_date: string | null;
}
export interface OcrData {
  currency_code: string | null;
  line_items: OcrLine[];
  taxes: { tax_amount: number | null; tax_name?: string | null; tax_rate?: number | null }[];
}
