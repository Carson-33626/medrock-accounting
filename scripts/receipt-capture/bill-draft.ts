// Vendor-agnostic Ramp draft-bill writer. Letco is the first consumer; Medisca (583 bills/yr),
// PCCA, TopRx and ULINE are the same shape and must be able to reuse this unchanged.
//
// We create DRAFTS only and never finalise: Ramp requires human review in its UI before a draft
// becomes a real bill, and that review is deliberately our approval gate.
import type { Entity } from '../ramp-split-push/types';
import type { CodedLine } from './letco-gl';

const BASE = 'https://api.ramp.com/developer/v1';

export interface AccountingFieldSelection {
  field_external_id: string;
  field_option_external_id: string;
}

export interface DraftBillLine {
  amount: number;
  memo: string;
  accounting_field_selections: AccountingFieldSelection[];
}

export interface DraftBillBody {
  vendor_id: string;
  invoice_number: string;
  issued_at: string;
  due_at: string;
  memo: string;
  line_items: DraftBillLine[];
  entity_id?: string;
}

export interface DraftBillInput {
  vendorId: string;
  entityId: string | null;
  invoiceNumber: string;
  issuedAt: string;
  dueAt: string;
  memo: string;
  lines: CodedLine[];
  glFieldExternalId: string;
  accountOptionIds: Record<string, string>;
}

export function buildDraftBillBody(input: DraftBillInput): DraftBillBody {
  const line_items: DraftBillLine[] = input.lines.map((l) => {
    const option = input.accountOptionIds[l.account];
    // An uncoded line would land in the accountant's lap as a mystery. Fail loudly instead.
    if (option === undefined) throw new Error(`No Ramp GL option mapped for account ${l.account}`);
    return {
      amount: l.amountCents / 100,
      memo: l.memo,
      accounting_field_selections: [
        { field_external_id: input.glFieldExternalId, field_option_external_id: option },
      ],
    };
  });

  const body: DraftBillBody = {
    vendor_id: input.vendorId,
    invoice_number: input.invoiceNumber,
    issued_at: input.issuedAt,
    due_at: input.dueAt,
    memo: input.memo,
    line_items,
  };
  if (input.entityId !== null) body.entity_id = input.entityId;
  return body;
}

export function buildBillAttachmentForm(pdf: Buffer, filename: string): FormData {
  const form = new FormData();
  form.set('attachment_type', 'INVOICE');
  form.set('file', new File([new Uint8Array(pdf)], filename, { type: 'application/pdf' }));
  return form;
}

export async function createDraftBill(
  entity: Entity,
  body: DraftBillBody,
  token: string,
): Promise<{ status: number; body: unknown }> {
  void entity; // entity is encoded in the token; kept for call-site symmetry and logging
  const res = await fetch(`${BASE}/bills/drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

export async function attachBillDocument(
  entity: Entity,
  draftId: string,
  pdf: Buffer,
  filename: string,
  token: string,
): Promise<{ status: number; body: unknown }> {
  void entity;
  const res = await fetch(`${BASE}/bills/drafts/${draftId}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }, // do NOT set Content-Type; fetch sets the boundary
    body: buildBillAttachmentForm(pdf, filename),
  });
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}
