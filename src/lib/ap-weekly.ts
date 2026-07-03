/**
 * Weekly AP Report — report-only automation of the dormant Monday AP routine.
 *
 * Reproduces the bookkeeper procedure (Apr 2025–Feb 2026, Amy Murphy's rules):
 * open AP per entity, duplicate detection, proposed auto-ACH payments
 * (report date + 7 days rule, batched by vendor + due date), and the
 * Ramp Bill Pay cross-check that was previously a manual XLOOKUP on invoice number.
 *
 * READ-ONLY: nothing here writes to QuickBooks or Ramp. "Proposed" payments and
 * "mark paid in Ramp" candidates are display-only pending controller sign-off.
 *
 * Source spec: docs/superpowers/specs/2026-07-03-weekly-ap-report-design.md
 */

import { qbQueryAll, type Location } from './quickbooks-multi';

// ── Entity mapping ──────────────────────────────────────────────────────────

export type RampEntity = 'FL' | 'TN' | 'TX';

export const LOCATION_TO_RAMP_ENTITY: Record<Location, RampEntity> = {
  'MedRock FL': 'FL',
  'MedRock TN': 'TN',
  'MedRock TX': 'TX',
};

// ── QBO entity shapes (fields we read) ──────────────────────────────────────

interface QbRef {
  value: string;
  name?: string;
}

interface QbBill {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  Balance?: number;
  TotalAmt?: number;
  VendorRef?: QbRef;
}

interface QbVendorCredit {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  Balance?: number;
  TotalAmt?: number;
  VendorRef?: QbRef;
}

// ── Ramp /bills shapes (verified against the live API 2026-07-03) ───────────

interface RampAmount {
  amount: number; // minor units
  currency_code?: string;
  minor_unit_conversion_rate?: number | null;
}

interface RampBillVendor {
  id?: string;
  name?: string | null;
  remote_name?: string | null;
  remote_id?: string | null;
}

interface RampBillPayment {
  payment_method?: string | null;
  payment_date?: string | null;
  effective_date?: string | null;
}

interface RampBillRaw {
  id: string;
  invoice_number?: string | null;
  status?: string | null; // e.g. OPEN, PAID
  status_summary?: string | null; // e.g. APPROVAL_PENDING
  paid_at?: string | null;
  due_at?: string | null;
  issued_at?: string | null;
  amount?: RampAmount | null;
  payment?: RampBillPayment | null;
  vendor?: RampBillVendor | null;
  remote_id?: string | null; // QBO Bill txn id — the strong join key
  deep_link_url?: string | null;
  sync_status?: string | null;
}

interface RampBillsPage {
  data?: RampBillRaw[];
  page?: { next?: string | null };
}

interface RampTokenResponse {
  access_token?: string;
  error_description?: string;
}

// ── Report output types ─────────────────────────────────────────────────────

export type AgingBucket = 'notDue' | '1-30' | '31-60' | '61-90' | '90+' | 'noDueDate';

export interface RampMatch {
  rampBillId: string;
  matchedBy: 'remoteId' | 'invoiceNumber';
  status: string;
  statusSummary: string | null;
  paymentMethod: string | null;
  paidAt: string | null;
  /** Amy's asymmetry rule: paid via Ramp by ACH/card → NEVER mark paid in QBO. */
  doNotMarkPaidInQbo: boolean;
}

export interface ApBillRow {
  qbId: string;
  vendor: string;
  invoiceNumber: string;
  txnDate: string;
  dueDate: string | null;
  openBalance: number;
  total: number;
  daysPastDue: number | null;
  agingBucket: AgingBucket;
  /** Vendor name matches the "- AutoPay" convention. */
  autoPayVendor: boolean;
  /** Due within the report-date + 7 days window. */
  dueInWindow: boolean;
  ramp: RampMatch | null;
}

export interface AutoAchBatchBill {
  qbId: string;
  invoiceNumber: string;
  openBalance: number;
}

export interface AutoAchBatch {
  vendor: string;
  dueDate: string;
  bills: AutoAchBatchBill[];
  total: number;
}

export interface DuplicateGroup {
  kind: 'exact' | 'suspected';
  vendor: string;
  /** exact: shared invoice #; suspected: shared amount + due date across invoice #s. */
  sharedKey: string;
  bills: ApBillRow[];
}

export type RampOrphanQboState = 'PAID_IN_QBO' | 'STILL_OPEN_IN_QBO' | 'NOT_FOUND_IN_QBO' | 'UNVERIFIED';

export interface RampOrphan {
  rampBillId: string;
  vendor: string;
  invoiceNumber: string;
  amount: number | null;
  dueAt: string | null;
  status: string;
  statusSummary: string | null;
  paymentMethod: string | null;
  qboState: RampOrphanQboState;
  deepLinkUrl: string | null;
}

export interface VendorCreditRow {
  qbId: string;
  vendor: string;
  docNumber: string;
  txnDate: string;
  openBalance: number;
  total: number;
}

export interface SourceError {
  source: 'quickbooks' | 'ramp';
  message: string;
}

export interface ApWeeklyTotals {
  openApTotal: number;
  billCount: number;
  dueInWindowTotal: number;
  dueInWindowCount: number;
  proposedAutoAchTotal: number;
  proposedAutoAchCount: number;
  duplicateGroupCount: number;
  markPaidInRampCandidates: number;
}

export interface ApWeeklyReport {
  location: Location;
  rampEntity: RampEntity;
  reportDate: string; // YYYY-MM-DD
  dueCutoff: string; // reportDate + 7 days
  generatedAt: string;
  totals: ApWeeklyTotals;
  bills: ApBillRow[];
  autoAchBatches: AutoAchBatch[];
  duplicates: DuplicateGroup[];
  rampOrphans: RampOrphan[];
  vendorCredits: VendorCreditRow[];
  errors: SourceError[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const AUTOPAY_RE = /auto.?pay/i;

/** Uppercase, strip non-alphanumerics and leading zeros — fixes the manual
 *  "convert to number" Excel matching pain from the original procedure. */
export function normalizeInvoiceNumber(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
  return cleaned;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

function agingBucketFor(daysPastDue: number | null): AgingBucket {
  if (daysPastDue === null) return 'noDueDate';
  if (daysPastDue <= 0) return 'notDue';
  if (daysPastDue <= 30) return '1-30';
  if (daysPastDue <= 60) return '31-60';
  if (daysPastDue <= 90) return '61-90';
  return '90+';
}

function rampAmountToDollars(a: RampAmount | null | undefined): number | null {
  if (!a || typeof a.amount !== 'number') return null;
  const rate = a.minor_unit_conversion_rate ?? 100;
  return a.amount / (rate > 0 ? rate : 100);
}

/** Ramp-managed ACH/card payments close the QBO bill from Ramp's side. */
function isRampManagedMethod(method: string | null): boolean {
  if (!method) return false;
  return /ach|card/i.test(method);
}

// ── Ramp fetch (self-contained; mirrors scripts/ramp-split-push/ramp-client) ─

const RAMP_BASE = 'https://api.ramp.com/developer/v1';

async function rampToken(entity: RampEntity): Promise<string> {
  const id = process.env[`RAMP_${entity}_CLIENT_ID`];
  const secret = process.env[`RAMP_${entity}_CLIENT_SECRET`];
  if (!id || !secret) throw new Error(`Missing RAMP_${entity}_CLIENT_ID/SECRET`);
  const res = await fetch(`${RAMP_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'bills:read' }),
  });
  const json = (await res.json()) as RampTokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(`Ramp token failed (${entity}): ${res.status} ${json.error_description ?? ''}`);
  }
  return json.access_token;
}

async function getRampBills(entity: RampEntity, maxPages = 30): Promise<RampBillRaw[]> {
  const token = await rampToken(entity);
  const out: RampBillRaw[] = [];
  let url: string | null = `${RAMP_BASE}/bills?page_size=100`;
  for (let i = 0; i < maxPages && url !== null; i++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ramp /bills failed (${entity}): ${res.status} ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as RampBillsPage;
    const rows = body.data ?? [];
    out.push(...rows);
    if (rows.length === 0) break;
    url = body.page?.next ?? null;
  }
  return out;
}

// ── QBO paid-in-QBO confirmation for Ramp orphans ───────────────────────────

async function fetchQbBillsByIds(location: Location, ids: string[]): Promise<Map<string, QbBill>> {
  const found = new Map<string, QbBill>();
  const numeric = ids.filter((id) => /^\d+$/.test(id));
  for (let i = 0; i < numeric.length; i += 20) {
    const chunk = numeric.slice(i, i + 20);
    const where = `WHERE Id IN (${chunk.map((id) => `'${id}'`).join(',')})`;
    const rows = await qbQueryAll<QbBill>(location, 'Bill', where);
    for (const row of rows) found.set(row.Id, row);
  }
  return found;
}

// ── Report builder ──────────────────────────────────────────────────────────

export async function buildApWeeklyReport(location: Location, reportDate: string): Promise<ApWeeklyReport> {
  const rampEntity = LOCATION_TO_RAMP_ENTITY[location];
  const dueCutoff = addDays(reportDate, 7);
  const errors: SourceError[] = [];

  // QB queries run sequentially — parallel calls against an expired token race the
  // refresh (QBO rotates refresh tokens; the loser gets invalid_grant → "not connected").
  // VendorCredit doesn't allow Balance in WHERE, so fetch all and filter here.
  const qbChain = async (): Promise<{ bills: QbBill[]; credits: QbVendorCredit[]; creditsError: string | null }> => {
    const bills = await qbQueryAll<QbBill>(location, 'Bill', "WHERE Balance > '0'");
    try {
      const allCredits = await qbQueryAll<QbVendorCredit>(location, 'VendorCredit', '');
      return { bills, credits: allCredits.filter((c) => (c.Balance ?? 0) > 0), creditsError: null };
    } catch (e) {
      return { bills, credits: [], creditsError: String(e) };
    }
  };
  const [qbRes, rampRes] = await Promise.allSettled([qbChain(), getRampBills(rampEntity)]);
  const billsRes: PromiseSettledResult<QbBill[]> =
    qbRes.status === 'fulfilled'
      ? { status: 'fulfilled', value: qbRes.value.bills }
      : { status: 'rejected', reason: qbRes.reason };
  const creditsRes: PromiseSettledResult<QbVendorCredit[]> =
    qbRes.status === 'fulfilled'
      ? qbRes.value.creditsError
        ? { status: 'rejected', reason: qbRes.value.creditsError }
        : { status: 'fulfilled', value: qbRes.value.credits }
      : { status: 'rejected', reason: qbRes.reason };

  const qbBills: QbBill[] = billsRes.status === 'fulfilled' ? billsRes.value : [];
  if (billsRes.status === 'rejected') {
    errors.push({ source: 'quickbooks', message: `Open bills query failed: ${String(billsRes.reason)}` });
  }

  const qbCredits: QbVendorCredit[] = creditsRes.status === 'fulfilled' ? creditsRes.value : [];
  if (creditsRes.status === 'rejected') {
    errors.push({ source: 'quickbooks', message: `Vendor credits query failed: ${String(creditsRes.reason)}` });
  }

  const rampBills: RampBillRaw[] = rampRes.status === 'fulfilled' ? rampRes.value : [];
  if (rampRes.status === 'rejected') {
    errors.push({ source: 'ramp', message: `Ramp bills fetch failed: ${String(rampRes.reason)}` });
  }

  // Index Ramp bills by their QBO remote id (strong key) and normalized invoice # (fallback).
  const rampByRemoteId = new Map<string, RampBillRaw>();
  const rampByInvoice = new Map<string, RampBillRaw>();
  for (const rb of rampBills) {
    if (rb.remote_id) rampByRemoteId.set(rb.remote_id, rb);
    const inv = normalizeInvoiceNumber(rb.invoice_number);
    if (inv && !rampByInvoice.has(inv)) rampByInvoice.set(inv, rb);
  }

  const matchedRampIds = new Set<string>();

  const bills: ApBillRow[] = qbBills.map((b) => {
    const vendor = b.VendorRef?.name ?? '(no vendor)';
    const dueDate = b.DueDate ?? null;
    const daysPastDue = dueDate ? daysBetween(dueDate, reportDate) : null;
    const normInv = normalizeInvoiceNumber(b.DocNumber);

    let rampBill = rampByRemoteId.get(b.Id) ?? null;
    let matchedBy: RampMatch['matchedBy'] = 'remoteId';
    if (!rampBill && normInv) {
      rampBill = rampByInvoice.get(normInv) ?? null;
      matchedBy = 'invoiceNumber';
    }
    let ramp: RampMatch | null = null;
    if (rampBill) {
      matchedRampIds.add(rampBill.id);
      const method = rampBill.payment?.payment_method ?? null;
      ramp = {
        rampBillId: rampBill.id,
        matchedBy,
        status: rampBill.status ?? 'UNKNOWN',
        statusSummary: rampBill.status_summary ?? null,
        paymentMethod: method,
        paidAt: rampBill.paid_at ?? null,
        doNotMarkPaidInQbo: isRampManagedMethod(method),
      };
    }

    return {
      qbId: b.Id,
      vendor,
      invoiceNumber: b.DocNumber ?? '',
      txnDate: b.TxnDate ?? '',
      dueDate,
      openBalance: b.Balance ?? 0,
      total: b.TotalAmt ?? 0,
      daysPastDue,
      agingBucket: agingBucketFor(daysPastDue),
      autoPayVendor: AUTOPAY_RE.test(vendor),
      dueInWindow: dueDate !== null && dueDate <= dueCutoff,
      ramp,
    };
  });

  bills.sort((a, b) => a.vendor.localeCompare(b.vendor) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));

  // Proposed auto-ACH payments: AutoPay vendors, due ≤ report date + 7 days,
  // batched by vendor + due date (the Medisca rule). PROPOSED ONLY — never posted.
  const batchMap = new Map<string, AutoAchBatch>();
  for (const row of bills) {
    if (!row.autoPayVendor || !row.dueInWindow || !row.dueDate) continue;
    const key = `${row.vendor}|${row.dueDate}`;
    let batch = batchMap.get(key);
    if (!batch) {
      batch = { vendor: row.vendor, dueDate: row.dueDate, bills: [], total: 0 };
      batchMap.set(key, batch);
    }
    batch.bills.push({ qbId: row.qbId, invoiceNumber: row.invoiceNumber, openBalance: row.openBalance });
    batch.total += row.openBalance;
  }
  const autoAchBatches = [...batchMap.values()].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.vendor.localeCompare(b.vendor),
  );

  // Duplicates — exact: same vendor + invoice #; suspected: same vendor + amount + due date.
  const duplicates: DuplicateGroup[] = [];
  const byVendorInvoice = new Map<string, ApBillRow[]>();
  for (const row of bills) {
    const inv = normalizeInvoiceNumber(row.invoiceNumber);
    if (!inv) continue;
    const key = `${row.vendor}|${inv}`;
    const group = byVendorInvoice.get(key);
    if (group) group.push(row);
    else byVendorInvoice.set(key, [row]);
  }
  const inExactGroup = new Set<string>();
  for (const [key, group] of byVendorInvoice) {
    if (group.length > 1) {
      duplicates.push({ kind: 'exact', vendor: group[0].vendor, sharedKey: key.split('|')[1], bills: group });
      for (const row of group) inExactGroup.add(row.qbId);
    }
  }
  const byVendorAmountDue = new Map<string, ApBillRow[]>();
  for (const row of bills) {
    if (inExactGroup.has(row.qbId) || !row.dueDate) continue;
    const key = `${row.vendor}|${row.total.toFixed(2)}|${row.dueDate}`;
    const group = byVendorAmountDue.get(key);
    if (group) group.push(row);
    else byVendorAmountDue.set(key, [row]);
  }
  for (const [key, group] of byVendorAmountDue) {
    const distinctInvoices = new Set(group.map((r) => normalizeInvoiceNumber(r.invoiceNumber)));
    if (group.length > 1 && distinctInvoices.size > 1) {
      const [, amount, due] = key.split('|');
      duplicates.push({ kind: 'suspected', vendor: group[0].vendor, sharedKey: `$${amount} due ${due}`, bills: group });
    }
  }

  // Ramp orphans: not paid in Ramp, absent from open AP → probably paid in QBO
  // → candidates to mark paid in Ramp (Amy's "Not There" rule). Confirm read-only via QBO.
  const orphanRaw = rampBills.filter(
    (rb) => !matchedRampIds.has(rb.id) && rb.status !== 'PAID' && !rb.paid_at && rb.status !== 'ARCHIVED',
  );
  let confirmedById = new Map<string, QbBill>();
  const orphanRemoteIds = orphanRaw.map((rb) => rb.remote_id).filter((id): id is string => !!id);
  if (orphanRemoteIds.length > 0) {
    try {
      confirmedById = await fetchQbBillsByIds(location, orphanRemoteIds);
    } catch (e) {
      errors.push({ source: 'quickbooks', message: `Paid-in-QBO confirmation query failed: ${String(e)}` });
    }
  }
  const rampOrphans: RampOrphan[] = orphanRaw
    .map((rb) => {
      let qboState: RampOrphanQboState = 'UNVERIFIED';
      if (rb.remote_id && confirmedById.size > 0) {
        const qb = confirmedById.get(rb.remote_id);
        if (!qb) qboState = 'NOT_FOUND_IN_QBO';
        else qboState = (qb.Balance ?? 0) <= 0 ? 'PAID_IN_QBO' : 'STILL_OPEN_IN_QBO';
      }
      return {
        rampBillId: rb.id,
        vendor: rb.vendor?.remote_name ?? rb.vendor?.name ?? '(unknown vendor)',
        invoiceNumber: rb.invoice_number ?? '',
        amount: rampAmountToDollars(rb.amount),
        dueAt: rb.due_at ? rb.due_at.slice(0, 10) : null,
        status: rb.status ?? 'UNKNOWN',
        statusSummary: rb.status_summary ?? null,
        paymentMethod: rb.payment?.payment_method ?? null,
        qboState,
        deepLinkUrl: rb.deep_link_url ?? null,
      };
    })
    .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));

  const vendorCredits: VendorCreditRow[] = qbCredits.map((c) => ({
    qbId: c.Id,
    vendor: c.VendorRef?.name ?? '(no vendor)',
    docNumber: c.DocNumber ?? '',
    txnDate: c.TxnDate ?? '',
    openBalance: c.Balance ?? 0,
    total: c.TotalAmt ?? 0,
  }));

  const dueInWindow = bills.filter((b) => b.dueInWindow);
  const totals: ApWeeklyTotals = {
    openApTotal: bills.reduce((s, b) => s + b.openBalance, 0),
    billCount: bills.length,
    dueInWindowTotal: dueInWindow.reduce((s, b) => s + b.openBalance, 0),
    dueInWindowCount: dueInWindow.length,
    proposedAutoAchTotal: autoAchBatches.reduce((s, b) => s + b.total, 0),
    proposedAutoAchCount: autoAchBatches.reduce((s, b) => s + b.bills.length, 0),
    duplicateGroupCount: duplicates.length,
    markPaidInRampCandidates: rampOrphans.filter((o) => o.qboState === 'PAID_IN_QBO').length,
  };

  return {
    location,
    rampEntity,
    reportDate,
    dueCutoff,
    generatedAt: new Date().toISOString(),
    totals,
    bills,
    autoAchBatches,
    duplicates,
    rampOrphans,
    vendorCredits,
    errors,
  };
}
