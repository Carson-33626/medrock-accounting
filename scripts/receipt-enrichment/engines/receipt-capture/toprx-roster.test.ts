import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseRosterRows } from './toprx-roster';
import type { RosterRowRaw } from './toprx-roster';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'toprx-roster-sample.json'), 'utf8'),
) as { rows: RosterRowRaw[] };

describe('parseRosterRows', () => {
  it('extracts orderId, invoice number, ISO date, and cents total from live-captured rows', () => {
    const orders = parseRosterRows(fixture.rows);
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) {
      expect(o.orderId).toMatch(/^\d+$/);
      expect(o.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(o.totalCents)).toBe(true);
      expect(o.totalCents).toBeGreaterThan(0);
    }
  });

  it('drops credit/return rows (IsOrderTypeCredit) since they have no receipt to capture', () => {
    const creditRaw = fixture.rows.find((r) => r.IsOrderTypeCredit);
    expect(creditRaw).toBeDefined();
    const orders = parseRosterRows(fixture.rows);
    expect(orders.find((o) => o.orderId === String(creditRaw?.Id))).toBeUndefined();
  });

  it('takes the invoice number from the Invoices array, not the always-blank InvoiceNumber field', () => {
    const withInvoice = fixture.rows.find((r) => !r.IsOrderTypeCredit && r.Invoices.length > 0);
    expect(withInvoice).toBeDefined();
    const orders = parseRosterRows(fixture.rows);
    const order = orders.find((o) => o.orderId === String(withInvoice?.Id));
    expect(order?.invoiceNumber).toBe(String(withInvoice?.Invoices[0]));
  });

  it('maps orderId from the numeric Id field (not CustomOrderNumber)', () => {
    const first = fixture.rows.find((r) => !r.IsOrderTypeCredit);
    const orders = parseRosterRows(fixture.rows);
    const order = orders.find((o) => o.orderId === String(first?.Id));
    expect(order).toBeDefined();
  });
});
