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

// ---- reading and patching drafts someone else created ----
//
// GET /bills does NOT return DRAFT-status bills — they live only in this collection. That gap is how
// the first live pilot created a duplicate of a draft the bookkeeper had already entered, so any
// dedupe that claims to know what Ramp holds MUST read this too.
export interface RampDraftSelection {
  external_code?: string | null;
  category_info?: { type?: string | null; external_id?: string | null } | null;
}

export interface RampDraftLine {
  amount?: { amount?: number } | null;
  memo?: string | null;
  accounting_field_selections?: RampDraftSelection[];
}

// NOT every accounting_field_selection is GL coding. Medisca's drafts carry a
// `{category_info:{type:'BILLABLE', external_id:'QuickbooksBillable'}, external_code:null}`
// selection meaning "Billable = false" — a flag, not an account. Treating any selection as "already
// coded" both overstates how much of the backlog is done and makes enrich skip drafts that have no
// GL account at all. Only a GL_ACCOUNT selection counts.
export function isGlCoded(selections: RampDraftSelection[] | undefined): boolean {
  return (selections ?? []).some((s) =>
    s.category_info?.type === 'GL_ACCOUNT' || (s.external_code ?? '') !== '');
}

export interface RampDraftBill {
  id: string;
  invoice_number?: string | null;
  memo?: string | null;
  created_at?: string | null;
  amount?: { amount?: number } | null;
  vendor?: { id?: string; name?: string | null } | null;
  bill_owner?: { first_name?: string | null; last_name?: string | null } | null;
  line_items?: RampDraftLine[];
}

interface DraftPage { data?: RampDraftBill[]; page?: { next?: string | null } }

export async function listDraftBills(
  entity: Entity,
  token: string,
  get: <T>(entity: Entity, pathOrUrl: string, token: string) => Promise<{ status: number; body: T }>,
  maxPages = 50,
): Promise<RampDraftBill[]> {
  const out: RampDraftBill[] = [];
  let url: string | null = '/bills/drafts?page_size=100';
  for (let i = 0; i < maxPages && url !== null; i++) {
    const res: { status: number; body: DraftPage } = await get<DraftPage>(entity, url, token);
    if (res.status !== 200) throw new Error(`Ramp /bills/drafts failed (${entity}): HTTP ${res.status}`);
    const rows = res.body.data ?? [];
    out.push(...rows);
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  return out;
}

export interface PatchDraftLinesBody {
  line_items: DraftBillLine[];
}

// PATCH line_items REPLACES the whole array, so this takes the draft's FULL line set, not a delta.
// Only line_items is sent: every other field on the draft is the bookkeeper's and stays untouched.
export function buildPatchLinesBody(
  lines: CodedLine[],
  glFieldExternalId: string,
  accountOptionIds: Record<string, string>,
): PatchDraftLinesBody {
  return {
    line_items: lines.map((l) => {
      const option = accountOptionIds[l.account];
      if (option === undefined) throw new Error(`No Ramp GL option mapped for account ${l.account}`);
      return {
        amount: l.amountCents / 100,
        memo: l.memo,
        accounting_field_selections: [
          { field_external_id: glFieldExternalId, field_option_external_id: option },
        ],
      };
    }),
  };
}

export async function patchDraftBillLines(
  entity: Entity,
  draftId: string,
  body: PatchDraftLinesBody,
  token: string,
): Promise<{ status: number; body: unknown }> {
  void entity;
  const res = await fetch(`${BASE}/bills/drafts/${draftId}`, {
    method: 'PATCH',
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
