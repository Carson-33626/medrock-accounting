// TopRx invoice PDF fetch + parse.
//
// fetchTopRxInvoicePdf: in-page `fetch` of /orderdetails/pdf/{orderId} (session cookies sent via
// credentials: 'include', same-origin) — same base64-bridge technique used for other in-page
// binary fetches in this pipeline: bytes never leave the page as a Buffer directly (Playwright's
// evaluate() return value must be JSON-serializable), so we base64-encode in chunks (String.fromCharCode
// over an 8k slice at a time — a single call over a big buffer overflows the argument stack) and
// decode back to a Buffer in Node.
//
// parseTopRxInvoice: pure text parser against the ONE real layout captured 2026-07-27 (order
// 4295395, invoice 10388214 — see fixtures/toprx-invoice-sample.{pdf,txt}). pdf-parse strips all
// column whitespace, so each item row arrives as a single glued line:
//   "<description><qty><price><AWP><amount>"   e.g. "TAVABOROLE 5% SOLN 10ML2415.331,525.00367.92"
// with no delimiter between the description and the numbers, or between the numbers themselves.
// The description/numbers boundary is found by taking the trailing run of only digits/dot/comma
// characters. Splitting that run into qty + price + AWP + amount is ambiguous on where qty ends
// (both qty and price's integer part are bare digits with no separator) — see splitItemNumbers,
// which tries each plausible qty length and keeps the first split where qty * price == amount.
// Conservative throughout: any unrecognized shape returns null immediately; the caller's
// item+tax+shipping == printedTotal reconcile check is the final backstop.
import type { Page } from 'playwright';
import type { VendorParsed } from './vendor-split';

export async function fetchTopRxInvoicePdf(page: Page, orderId: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (id: string) => {
    const res = await fetch('/orderdetails/pdf/' + id, { credentials: 'include' });
    if (!res.ok) throw new Error(`TopRx invoice fetch failed: ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const chunks: string[] = [];
    const CHUNK = 8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
    }
    return btoa(chunks.join(''));
  }, orderId);

  const pdf = Buffer.from(base64, 'base64');
  if (pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`TopRx order ${orderId}: /orderdetails/pdf response is not a PDF (magic bytes mismatch)`);
  }
  return pdf;
}

function toCents(s: string): number {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

interface ItemNumbers { qty: number; priceCents: number; amountCents: number }

// Splits a glued "<qty><price><AWP><amount>" run (e.g. "2415.331,525.00367.92") into its parts.
// qty's length is ambiguous (no separator before price's integer part), so this tries qty
// lengths 1-3 and accepts the first split whose qty * priceCents === amountCents.
function splitItemNumbers(raw: string): ItemNumbers | null {
  const MONEY = '(\\d{1,3}(?:,\\d{3})*\\.\\d{2})';
  const tailRe = new RegExp(`^${MONEY}${MONEY}${MONEY}$`);
  for (let qtyLen = 1; qtyLen <= 3 && qtyLen < raw.length; qtyLen++) {
    const qtyStr = raw.slice(0, qtyLen);
    if (!/^\d+$/.test(qtyStr)) break;
    const m = tailRe.exec(raw.slice(qtyLen));
    if (!m) continue;
    const qty = Number(qtyStr);
    const priceCents = toCents(m[1]);
    const amountCents = toCents(m[3]);
    if (!Number.isFinite(priceCents) || !Number.isFinite(amountCents)) continue;
    if (qty * priceCents === amountCents) return { qty, priceCents, amountCents };
  }
  return null;
}

const NDC_RE = /^[\d]{4,5}-[\d]{3,4}-[\d]{2}$/;
const FEE_RE = /^(Freight|Fuel\s*Surcharge|Handling\s*Fee|Delivery\s*Charge)\s*[.\s]*\$?([\d,]+\.\d{2})$/i;

export function parseTopRxInvoice(text: string): VendorParsed | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const norm = (l: string): string => l.replace(/\s+/g, '');

  const headerIdx = lines.findIndex((l) => /^itemquantitypriceawpamount$/i.test(norm(l)));
  if (headerIdx === -1) return null;

  // Invoice number: "Invoice DateInvoice" header line is followed by "<MM/DD/YY><invoiceNumber>".
  const dateHdrIdx = lines.findIndex((l) => /^invoicedateinvoice$/i.test(norm(l)));
  let invoiceNumber: string | null = null;
  if (dateHdrIdx !== -1 && lines[dateHdrIdx + 1]) {
    const m = /^(\d{2}\/\d{2}\/\d{2})(\d+)$/.exec(lines[dateHdrIdx + 1]);
    if (m) invoiceNumber = m[2];
  }

  const items: { desc: string; amountCents: number; category: null }[] = [];
  let footerIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^order\s*(line\s*)?total\b/i.test(lines[i])) { footerIdx = i; break; }
    if (!/^Lot\.\s*\d+/i.test(lines[i])) continue;

    const descLine = lines[i - 1] ?? '';
    const numMatch = /([\d,.]+)$/.exec(descLine);
    if (!numMatch) return null;
    const descText = descLine.slice(0, descLine.length - numMatch[1].length).trim();
    const nums = splitItemNumbers(numMatch[1]);
    if (!descText || !nums) return null;

    const ndcLine = lines[i + 1] ?? '';
    const ndc = NDC_RE.test(ndcLine) ? ndcLine : null;
    const desc = `${descText} x${nums.qty}${ndc ? ` (NDC ${ndc})` : ''}`;
    items.push({ desc, amountCents: nums.amountCents, category: null });
  }
  if (items.length === 0) return null;

  // Footer fees (freight/fuel surcharge/etc.) between the item section and "Invoice Amount Due".
  // None observed in the captured sample, but the invoice's own boilerplate references a fuel
  // surcharge as a possible line item on other invoices, so this is recognized defensively.
  let shippingCents = 0;
  const dueIdx = lines.findIndex((l) => /^invoiceamountdue$/i.test(norm(l)));
  const feeScanEnd = dueIdx === -1 ? lines.length : dueIdx;
  for (let i = footerIdx; i < feeScanEnd; i++) {
    const m = FEE_RE.exec(lines[i]);
    if (m) shippingCents += toCents(m[2]);
  }
  const taxCents = 0;

  // Total: "Invoice Amount Due" is followed by the amount on its own line; fall back to the
  // "Order total . . . <amount>" footer line if that anchor isn't present.
  let parsedTotalCents: number | null = null;
  if (dueIdx !== -1 && lines[dueIdx + 1]) {
    const t = toCents(lines[dueIdx + 1]);
    if (Number.isFinite(t)) parsedTotalCents = t;
  }
  if (parsedTotalCents === null) {
    const ot = lines.find((l) => /^order\s*total\b/i.test(l));
    const m = ot ? /([\d,]+\.\d{2})\s*$/.exec(ot) : null;
    if (m) parsedTotalCents = toCents(m[1]);
  }
  if (parsedTotalCents === null) return null;

  const sum = items.reduce((a, b) => a + b.amountCents, 0) + taxCents + shippingCents;
  if (sum !== parsedTotalCents) return null;

  return {
    layout: null,
    source: null,
    order: invoiceNumber,
    glHint: null,
    items,
    taxCents,
    shippingCents,
    tipCents: 0,
    parsedTotalCents,
  };
}
