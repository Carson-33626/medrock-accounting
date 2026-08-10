// Walmart order id normalization + URL construction. Emails carry the dashed form
// (2000132-07850010); the /orders/{id} route uses the dash-stripped form.
export function normalizeOrderId(raw: string): string {
  return raw.replace(/[^0-9]/g, '');
}
export function buildInvoiceUrl(orderId: string): string {
  return `https://www.walmart.com/orders/${normalizeOrderId(orderId)}`;
}
export function buildOrderHistoryUrl(): string {
  return 'https://www.walmart.com/orders';
}
