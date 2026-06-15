/**
 * PDF builder for the Florida DR-15 filing packet (pdf-lib — pure JS, Vercel-safe).
 * Page 1: DR-15 summary boxes + derivation. Then the taxable-transaction detail
 * (rows that drive Box 3/4). The full transaction dump lives in the CSV/XLSX
 * exports — a PDF of all ~13k exempt rows would be hundreds of pages.
 */

import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import type { FlDr15Response, TxReturnResponse } from '@/types/sales-tax';
import type { FlSourceRow } from './sales-tax-fl';
import type { TxSourceRow } from './sales-tax-tx';

const usd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const PURPLE = rgb(0.369, 0.231, 0.553);
const GRAY = rgb(0.42, 0.45, 0.5);
const BLACK = rgb(0.1, 0.12, 0.16);

export async function buildFlDr15Pdf(result: FlDr15Response, sourceRows: FlSourceRow[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([612, 792]); // US Letter
  const margin = 54;
  let y = 792 - margin;

  const text = (s: string, x: number, yy: number, opts: { size?: number; font?: PDFFont; color?: typeof BLACK } = {}) => {
    page.drawText(s, { x, y: yy, size: opts.size ?? 10, font: opts.font ?? font, color: opts.color ?? BLACK });
  };
  const right = (s: string, xRight: number, yy: number, opts: { size?: number; font?: PDFFont; color?: typeof BLACK } = {}) => {
    const f = opts.font ?? font;
    const size = opts.size ?? 10;
    const w = f.widthOfTextAtSize(s, size);
    page.drawText(s, { x: xRight - w, y: yy, size, font: f, color: opts.color ?? BLACK });
  };
  const ensure = (need: number) => {
    if (y < margin + need) {
      page = doc.addPage([612, 792]);
      y = 792 - margin;
    }
  };

  // Header
  text('MedRock Pharmacy — Florida', margin, y, { size: 11, font: bold, color: GRAY });
  y -= 22;
  text(`Sales & Use Tax Return (DR-15EZ) — ${result.month}`, margin, y, { size: 18, font: bold, color: PURPLE });
  y -= 16;
  text(
    `Generated ${new Date().toISOString().slice(0, 10)} from the LifeFile sales-tax feed` +
      (result.feedAsOf ? ` (data as of ${result.feedAsOf.slice(0, 10)})` : ''),
    margin,
    y,
    { size: 8, color: GRAY },
  );
  y -= 28;

  // DR-15 boxes
  const b = result.boxes;
  const boxRows: [string, string, number, boolean][] = [
    ['Box 1', 'Gross Sales', b.box1_gross, false],
    ['Box 2', 'Exempt Sales', b.box2_exempt, false],
    ['Box 3', 'Total Taxable Amount', b.box3_taxable, false],
    ['Box 4', 'Total Tax Due', b.box4_tax, true],
    ['Box B', 'Discretionary Surtax (memo)', b.boxB_surtax, false],
    ['Box 8a', 'Collection Allowance', b.box8a_allowance, false],
  ];
  text('DR-15EZ Form Values', margin, y, { size: 12, font: bold });
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 1, color: PURPLE });
  y -= 18;
  for (const [line, label, value, hl] of boxRows) {
    text(line, margin, y, { size: 10, font: bold, color: hl ? PURPLE : BLACK });
    text(label, margin + 60, y, { size: 10, color: hl ? PURPLE : BLACK });
    right(usd(value), 612 - margin, y, { size: 10, font: hl ? bold : font, color: hl ? PURPLE : BLACK });
    y -= 18;
  }
  y -= 14;

  // Derivation
  const i = result.inputs;
  const d = result.diagnostics;
  text('Derivation', margin, y, { size: 12, font: bold });
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 0.5, color: GRAY });
  y -= 16;
  const deriv: [string, string][] = [
    [`Sales basis (${i.salesBasisSource === 'sales_sum' ? 'summed FL sales' : 'manual override'})`, usd(i.salesBasis)],
    ['Tax collected (F4)', usd(i.taxCollected)],
    ['Taxable sales (E4, per-county backout)', usd(i.taxableSales)],
    [`  vs flat ${(d.flatRate * 100).toFixed(1)}% method`, usd(d.flatRateTaxableBase)],
    ['Taxable purchases (E7, use tax)', usd(i.taxablePurchases)],
    ['Sales/use tax on purchases (F7)', usd(i.salesUseTax)],
    ['FL transactions / taxable', `${d.totalTransactions.toLocaleString()} / ${d.taxableTransactions}`],
  ];
  for (const [label, value] of deriv) {
    text(label, margin, y, { size: 9, color: GRAY });
    right(value, 612 - margin, y, { size: 9 });
    y -= 15;
  }
  if (d.unknownCountyRows > 0) {
    y -= 4;
    text(`Note: ${d.unknownCountyRows} taxable row(s) had unknown county — used 1% default surtax.`, margin, y, {
      size: 8,
      color: rgb(0.7, 0.45, 0.0),
    });
    y -= 14;
  }
  y -= 12;

  // Taxable transaction detail
  const taxable = sourceRows.filter((r) => r.tax > 0);
  ensure(60);
  text(`Taxable Transaction Detail (${taxable.length})`, margin, y, { size: 12, font: bold });
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 0.5, color: GRAY });
  y -= 16;
  // columns
  const cols = { tx: margin, date: margin + 80, county: margin + 150, rate: 612 - margin - 150, sub: 612 - margin - 90, tax: 612 - margin };
  text('Tx ID', cols.tx, y, { size: 8, font: bold, color: GRAY });
  text('Date', cols.date, y, { size: 8, font: bold, color: GRAY });
  text('County', cols.county, y, { size: 8, font: bold, color: GRAY });
  right('Rate', cols.rate, y, { size: 8, font: bold, color: GRAY });
  right('Taxable', cols.sub, y, { size: 8, font: bold, color: GRAY });
  right('Tax', cols.tax, y, { size: 8, font: bold, color: GRAY });
  y -= 13;
  for (const r of taxable) {
    ensure(16);
    if (y === 792 - margin) {
      // new page header repeat
      text('Taxable Transaction Detail (cont.)', margin, y, { size: 10, font: bold, color: GRAY });
      y -= 18;
    }
    text(r.tx_id, cols.tx, y, { size: 8 });
    text(r.date, cols.date, y, { size: 8 });
    text(r.county.replace(' County', '').slice(0, 16), cols.county, y, { size: 8 });
    right(`${(r.combined_rate * 100).toFixed(2)}%`, cols.rate, y, { size: 8 });
    right(usd(r.taxable_base), cols.sub, y, { size: 8 });
    right(usd(r.tax), cols.tax, y, { size: 8 });
    y -= 13;
  }

  y -= 18;
  ensure(20);
  text(
    `Full source data (all ${result.diagnostics.totalTransactions.toLocaleString()} FL transactions) is available in the CSV and XLSX exports.`,
    margin,
    y,
    { size: 8, color: GRAY },
  );

  return doc.save();
}

/**
 * PDF builder for a Texas Sales & Use Tax return (WebFile / 01-114).
 * Page 1: the WebFile line values + derivation + jurisdiction local-tax breakdown,
 * then the taxable-transaction detail. Full dump lives in CSV/XLSX.
 */
export async function buildTxReturnPdf(result: TxReturnResponse, sourceRows: TxSourceRow[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([612, 792]);
  const margin = 54;
  let y = 792 - margin;

  const text = (s: string, x: number, yy: number, opts: { size?: number; font?: PDFFont; color?: typeof BLACK } = {}) => {
    page.drawText(s, { x, y: yy, size: opts.size ?? 10, font: opts.font ?? font, color: opts.color ?? BLACK });
  };
  const right = (s: string, xRight: number, yy: number, opts: { size?: number; font?: PDFFont; color?: typeof BLACK } = {}) => {
    const f = opts.font ?? font;
    const size = opts.size ?? 10;
    page.drawText(s, { x: xRight - f.widthOfTextAtSize(s, size), y: yy, size, font: f, color: opts.color ?? BLACK });
  };
  const ensure = (need: number) => {
    if (y < margin + need) {
      page = doc.addPage([612, 792]);
      y = 792 - margin;
    }
  };

  const b = result.boxes;

  // Header
  text(`${result.filing.location} — Texas`, margin, y, { size: 11, font: bold, color: GRAY });
  y -= 22;
  text(`Texas Sales & Use Tax (01-114) — ${result.period}`, margin, y, { size: 18, font: bold, color: PURPLE });
  y -= 16;
  text(
    `Generated ${new Date().toISOString().slice(0, 10)} from the LifeFile sales-tax feed` +
      (result.feedAsOf ? ` (data as of ${result.feedAsOf.slice(0, 10)})` : '') +
      ` · months covered: ${result.diagnostics.monthsCovered.join(', ') || 'none'}`,
    margin,
    y,
    { size: 8, color: GRAY },
  );
  y -= 28;

  // WebFile line values
  const lineRows: [string, string, number, boolean][] = [
    ['Item 1', 'Total Texas Sales', b.totalTexasSales, false],
    ['Item 2', 'Taxable Sales', b.taxableSales, false],
    ['Item 3', 'Taxable Purchases', b.taxablePurchases, false],
    ['', 'Amount Subject to State Tax', b.subjectToStateTax, false],
    ['', `State Tax Due (${(b.stateTaxRate * 100).toFixed(4)}%)`, b.stateTaxDue, false],
    ['', `Local Tax Due (${(b.combinedLocalRate * 100).toFixed(3)}%)`, b.totalLocalTaxDue, false],
    ['', 'Total Tax Due', b.totalTaxDue, true],
    ['', 'Timely Filing Discount (0.5%)', -b.timelyFilingDiscount, false],
    ['', 'Net Tax Due', b.netTaxDue, true],
  ];
  text('WebFile Values', margin, y, { size: 12, font: bold });
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 1, color: PURPLE });
  y -= 18;
  for (const [line, label, value, hl] of lineRows) {
    text(line, margin, y, { size: 10, font: bold, color: hl ? PURPLE : BLACK });
    text(label, margin + 60, y, { size: 10, color: hl ? PURPLE : BLACK });
    right(usd(value), 612 - margin, y, { size: 10, font: hl ? bold : font, color: hl ? PURPLE : BLACK });
    y -= 18;
  }
  y -= 12;

  // Local jurisdiction breakdown
  ensure(40);
  text('Local Tax by Jurisdiction', margin, y, { size: 12, font: bold });
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 0.5, color: GRAY });
  y -= 16;
  for (const l of b.localLines) {
    text(`${l.name}${l.code ? ` (${l.code})` : ''}`, margin, y, { size: 9, color: GRAY });
    right(`${(l.rate * 100).toFixed(3)}%`, 612 - margin - 100, y, { size: 9, color: GRAY });
    right(usd(l.localTaxDue), 612 - margin, y, { size: 9 });
    y -= 15;
  }
  y -= 12;

  // Derivation
  const d = result.diagnostics;
  ensure(60);
  text('Derivation', margin, y, { size: 12, font: bold });
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 0.5, color: GRAY });
  y -= 16;
  const deriv: [string, string][] = [
    ['Summed Subtotal (Item 1 basis)', usd(d.summedSubtotalExact)],
    [`Taxable base (backout @ ${(d.combinedRate * 100).toFixed(2)}%, capped)`, usd(d.taxableBaseExact)],
    ['Tax actually collected by LifeFile', usd(d.summedTaxCollected)],
    ['TX transactions / taxable', `${d.totalTransactions.toLocaleString()} / ${d.taxableTransactions}`],
  ];
  for (const [label, value] of deriv) {
    text(label, margin, y, { size: 9, color: GRAY });
    right(value, 612 - margin, y, { size: 9 });
    y -= 15;
  }
  y -= 12;

  // Taxable transaction detail
  const taxable = sourceRows.filter((r) => r.tax > 0);
  ensure(60);
  text(`Taxable Transaction Detail (${taxable.length})`, margin, y, { size: 12, font: bold });
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 0.5, color: GRAY });
  y -= 16;
  const cols = { tx: margin, date: margin + 80, county: margin + 150, sub: 612 - margin - 90, tax: 612 - margin };
  text('Tx ID', cols.tx, y, { size: 8, font: bold, color: GRAY });
  text('Date', cols.date, y, { size: 8, font: bold, color: GRAY });
  text('County', cols.county, y, { size: 8, font: bold, color: GRAY });
  right('Taxable', cols.sub, y, { size: 8, font: bold, color: GRAY });
  right('Tax', cols.tax, y, { size: 8, font: bold, color: GRAY });
  y -= 13;
  for (const r of taxable) {
    ensure(16);
    text(r.tx_id, cols.tx, y, { size: 8 });
    text(r.date, cols.date, y, { size: 8 });
    text(r.county.replace(' County', '').slice(0, 16), cols.county, y, { size: 8 });
    right(usd(r.taxable_base), cols.sub, y, { size: 8 });
    right(usd(r.tax), cols.tax, y, { size: 8 });
    y -= 13;
  }

  y -= 18;
  ensure(20);
  text(
    `Full source data (all ${d.totalTransactions.toLocaleString()} TX transactions) is available in the CSV and XLSX exports.`,
    margin,
    y,
    { size: 8, color: GRAY },
  );

  return doc.save();
}
