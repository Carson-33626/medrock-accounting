// scripts/receipt-capture/audit.ts
// Append-only CSV audit for live actions (mirrors amazon-enrich run audit fields).
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface AuditRow {
  runId: string;
  mode: 'dry_run' | 'live';
  vendor: string;
  entity: string;
  txnId: string;
  action: 'attach_receipt' | 'memo' | 'split' | 'skip' | 'error';
  invoiceKey: string;
  amountCents: number;
  status: number | null;
  detail: string;
}

export function appendAudit(path: string, row: AuditRow): void {
  mkdirSync(dirname(path), { recursive: true });
  const header = 'ts,run_id,mode,vendor,entity,txn_id,action,invoice_key,amount_cents,status,detail';
  const cell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const line = [
    new Date().toISOString(), row.runId, row.mode, row.vendor, row.entity, row.txnId,
    row.action, row.invoiceKey, String(row.amountCents), row.status === null ? '' : String(row.status), cell(row.detail),
  ].join(',');
  if (!existsSync(path)) appendFileSync(path, header + '\n');
  appendFileSync(path, line + '\n');
}
