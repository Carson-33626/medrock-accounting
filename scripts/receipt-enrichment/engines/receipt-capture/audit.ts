// scripts/receipt-enrichment/engines/receipt-capture/audit.ts
// Append-only CSV audit for live actions (mirrors amazon-enrich run audit fields).
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface AuditRow {
  runId: string;
  mode: 'dry_run' | 'live';
  vendor: string;
  entity: string;
  txnId: string;
  // create_draft/attach_pdf added for the Letco bill-draft pipeline (run-letco.ts) — additive only,
  // every existing receipt-attach caller's action values are still valid members of this union.
  // patch_draft_gl = enrich mode: GL-coding added to a draft bill the bookkeeper already created.
  action: 'attach_receipt' | 'memo' | 'split' | 'unsplit' | 'skip' | 'error' | 'create_draft' | 'attach_pdf' | 'patch_draft_gl';
  invoiceKey: string;
  amountCents: number;
  status: number | null;
  detail: string;
  priorMemo: string | null;
  priorLineItems: string;
}

// New columns are appended at the END so any pre-existing audit.csv (10-col schema, before
// priorMemo/priorLineItems existed) stays column-compatible for its already-written rows. The
// header line is only written when the file doesn't yet exist — if a pre-existing file's header
// predates these columns, this function does NOT rewrite it; rows appended below it will still
// carry all 13 columns, so the file ends up with a stale 10-col header over a mix of 10-col and
// 13-col rows. out/ is gitignored and fresh per machine, so this only bites mid-session on a
// machine that already ran an older build today — acceptable given the append-only design.
export function appendAudit(path: string, row: AuditRow): void {
  mkdirSync(dirname(path), { recursive: true });
  const header = 'ts,run_id,mode,vendor,entity,txn_id,action,invoice_key,amount_cents,status,detail,prior_memo,prior_line_items';
  const cell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const line = [
    new Date().toISOString(), row.runId, row.mode, row.vendor, row.entity, row.txnId,
    row.action, row.invoiceKey, String(row.amountCents), row.status === null ? '' : String(row.status), cell(row.detail),
    row.priorMemo === null ? '' : cell(row.priorMemo), cell(row.priorLineItems),
  ].join(',');
  if (!existsSync(path)) appendFileSync(path, header + '\n');
  appendFileSync(path, line + '\n');
}
