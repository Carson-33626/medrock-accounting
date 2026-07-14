// Render an itemized receipt PDF from a cached Walmart order (the extraction stores structured JSON, not
// a PDF). This is a generated itemized statement — order #, date, every line item + price, and the
// tax/fees/tip/total that reconcile to the Ramp charge — suitable for attaching to the Ramp transaction.
// Deterministic and offline: no re-fetching Walmart. pdf-lib is already a dependency.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type { ExtractedOrder } from './extraction-store';

const money = (c: number): string => `$${(c / 100).toFixed(2)}`;

// Trim a description to fit the item column so the amount never overlaps it.
function fit(font: PDFFont, text: string, size: number, maxWidth: number): string {
  let s = text;
  while (s.length > 1 && font.widthOfTextAtSize(s, size) > maxWidth) s = s.slice(0, -2);
  return s === text ? s : `${s.slice(0, -1)}…`;
}

export async function buildReceiptPdf(rec: ExtractedOrder): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54, amtX = W - M;      // Letter, 0.75in margins; amounts right-aligned at amtX
  const gray = rgb(0.45, 0.45, 0.45);
  const line = rgb(0.8, 0.8, 0.8);

  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const right = (p: PDFPage, text: string, yy: number, f: PDFFont, size: number, color = rgb(0, 0, 0)): void => {
    p.drawText(text, { x: amtX - f.widthOfTextAtSize(text, size), y: yy, size, font: f, color });
  };
  const header = (): void => {
    page.drawText('Walmart — Itemized Receipt', { x: M, y, size: 16, font: bold });
    y -= 20;
    page.drawText(`Order ${rec.orderId}`, { x: M, y, size: 10, font, color: gray });
    right(page, `Order date: ${rec.date}`, y, font, 10, gray);
    y -= 22;
    page.drawLine({ start: { x: M, y }, end: { x: amtX, y }, thickness: 1, color: line });
    y -= 8;
    page.drawText('Item', { x: M, y, size: 9, font: bold, color: gray });
    right(page, 'Amount', y, bold, 9, gray);
    y -= 14;
  };
  header();

  for (const it of rec.items) {
    if (y < M + 90) { page = doc.addPage([W, H]); y = H - M; header(); } // new page; keep room for the totals block
    page.drawText(fit(font, it.desc, 10, amtX - M - 90), { x: M, y, size: 10, font });
    right(page, money(it.amountCents), y, font, 10);
    y -= 15;
  }

  // Totals block
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: amtX, y }, thickness: 1, color: line });
  y -= 16;
  const subtotalCents = rec.items.reduce((a, b) => a + b.amountCents, 0);
  const rows: [string, number, boolean][] = [
    ['Subtotal', subtotalCents, false],
    ['Tax', rec.taxCents, false],
    ['Delivery / fees', rec.shippingCents, false],
    ['Driver tip', rec.tipCents, false],
    ['Total', rec.parsedTotalCents, true],
  ];
  for (const [label, cents, isTotal] of rows) {
    if (cents === 0 && !isTotal) continue; // hide zero fee/tip/tax rows; always show subtotal + total
    const f = isTotal ? bold : font;
    page.drawText(label, { x: amtX - 200, y, size: isTotal ? 11 : 10, font: f });
    right(page, money(cents), y, f, isTotal ? 11 : 10);
    y -= isTotal ? 18 : 15;
  }
  y -= 8;
  page.drawText('Generated from Walmart order data for expense itemization. Amounts reconcile to the card charge.',
    { x: M, y, size: 7.5, font, color: gray });

  return doc.save();
}
