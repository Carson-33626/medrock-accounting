import { describe, it, expect } from 'vitest';
import { buildDraftBillBody, buildBillAttachmentForm } from './bill-draft';

const input = {
  vendorId: 'vend-1',
  entityId: 'ent-fl',
  invoiceNumber: 'C335-176896',
  issuedAt: '2026-08-04',
  dueAt: '2026-09-03',
  memo: 'Letco invoice C335-176896',
  glFieldExternalId: 'QuickbooksCategory',
  accountOptionIds: { '1220.10': 'opt-prod', '5000.45': 'opt-ship' },
  lines: [
    { amountCents: 500000, memo: 'TrichoSol', account: '1220.10' },
    { amountCents: 16498, memo: 'Shipping & handling', account: '5000.45' },
  ],
};

describe('buildDraftBillBody', () => {
  it('carries the identifying fields Ramp requires', () => {
    const body = buildDraftBillBody(input);
    expect(body.vendor_id).toBe('vend-1');
    expect(body.invoice_number).toBe('C335-176896');
    expect(body.issued_at).toBe('2026-08-04');
    expect(body.due_at).toBe('2026-09-03');
  });

  it('emits one line item per coded line, in dollars', () => {
    const body = buildDraftBillBody(input);
    expect(body.line_items).toHaveLength(2);
    expect(body.line_items[0].amount).toBe(5000.0);
    expect(body.line_items[1].amount).toBe(164.98);
  });

  it('codes each line with its own GL option', () => {
    const body = buildDraftBillBody(input);
    expect(body.line_items[0].accounting_field_selections[0]).toEqual({
      field_external_id: 'QuickbooksCategory',
      field_option_external_id: 'opt-prod',
    });
    expect(body.line_items[1].accounting_field_selections[0].field_option_external_id).toBe('opt-ship');
  });

  it('throws when an account has no mapped option rather than posting an uncoded line', () => {
    expect(() => buildDraftBillBody({ ...input, accountOptionIds: { '1220.10': 'opt-prod' } })).toThrow(/5000\.45/);
  });

  it('omits entity_id when there is none rather than sending null', () => {
    const body = buildDraftBillBody({ ...input, entityId: null });
    expect('entity_id' in body).toBe(false);
  });
});

describe('buildBillAttachmentForm', () => {
  it('sends the file and marks it as the invoice', () => {
    const form = buildBillAttachmentForm(Buffer.from('%PDF-1.4 x'), 'C335-176896.pdf');
    expect(form.get('attachment_type')).toBe('INVOICE');
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('C335-176896.pdf');
  });
});
