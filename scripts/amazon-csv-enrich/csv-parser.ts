// Parse the Amazon Business "Items" order-history CSV into per-charge groups.
// Quote-aware (Account Group + Title carry commas/quotes); reads by header NAME (72-col report,
// order not assumed); groups item rows by Payment Reference ID = one card charge = one Ramp txn.
import { unwrapExcel, parseMoneyCents, parseMDY } from './csv-fields';
import type { AmazonCharge, AmazonItem } from './types';

const SKIP_INSTRUMENTS = new Set(['N/A', 'Business Credit Account']);

// RFC-4180-ish tokenizer: handles quoted fields with embedded commas, newlines, and "" escapes.
function tokenize(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* ignore */ }
    else cur += c;
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

export function parseCsvRows(text: string): Record<string, string>[] {
  const grid = tokenize(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (grid.length < 2) return [];
  const header = grid[0].map((h) => unwrapExcel(h));
  const out: Record<string, string>[] = [];
  for (let i = 1; i < grid.length; i++) {
    const rec: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) rec[header[j]] = grid[i][j] ?? '';
    out.push(rec);
  }
  return out;
}

export function parseAmazonCsv(text: string): AmazonCharge[] {
  const rows = parseCsvRows(text);
  const byRef = new Map<string, AmazonCharge>();
  let dropped = 0;
  for (const r of rows) {
    const paymentRef = unwrapExcel(r['Payment Reference ID'] ?? '');
    if (!paymentRef) continue;
    const instrument = unwrapExcel(r['Payment Instrument Type'] ?? '');
    if (SKIP_INSTRUMENTS.has(instrument)) continue;

    const orderId = unwrapExcel(r['Order ID'] ?? '');
    const itemAmount = parseMoneyCents(r['Item Net Total'] ?? '');
    const item: AmazonItem | null = Number.isFinite(itemAmount)
      ? { desc: unwrapExcel(r['Title'] ?? ''), amountCents: itemAmount }
      : null;

    if (!item) dropped++;

    let charge = byRef.get(paymentRef);
    if (!charge) {
      const last4 = unwrapExcel(r['Payment Identifier'] ?? '');
      charge = {
        paymentRef,
        orderIds: [],
        primaryOrderId: orderId,
        accountGroup: unwrapExcel(r['Account Group'] ?? ''),
        chargeCents: parseMoneyCents(r['Payment Amount'] ?? ''),
        payDate: parseMDY(r['Payment Date'] ?? ''),
        cardLast4: last4 && last4 !== 'N/A' ? last4 : null,
        items: [],
        itemsTotalCents: 0,
      };
      byRef.set(paymentRef, charge);
    }
    if (orderId && !charge.orderIds.includes(orderId)) charge.orderIds.push(orderId);
    if (item) { charge.items.push(item); charge.itemsTotalCents += item.amountCents; }
  }
  if (dropped > 0) console.warn(`[csv-parser] dropped ${dropped} item row(s) with unparseable Item Net Total`);
  return [...byRef.values()];
}
