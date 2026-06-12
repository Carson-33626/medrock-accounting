/**
 * Phase 4 — QuickBooks purchase linkage engine.
 *
 * Fetches Bills + Purchases + BillPayments from QBO, snapshots them into
 * inventory.qb_documents, and auto-matches receiving entries
 * (inventory.purchase_lots) against them into inventory.qb_purchase_links.
 *
 * Match policy (validated by scripts/inventory_investigation/qb_probe_*.py —
 * TN auto-matched 60.6% of receipt value, 23.8% review, 15.7% unmatched):
 *   1. normalized vendor + exact amount (line or doc total) within ±45d -> auto (0.95)
 *   2. exact amount, vendor-less, unique doc within window               -> auto (0.75)
 *   3. exact amount, multiple candidate docs                             -> review
 *   4. nothing                                                           -> unmatched
 * Manual/rejected decisions are never overwritten by a sync.
 *
 * Spec: docs/superpowers/specs/2026-06-12-fifo-qb-purchase-linkage.md
 */

import type { PoolClient } from 'pg';
import { getRdsPool } from './rds';
import { qbQueryAll, type Location } from './quickbooks-multi';
import type { QbDocType, QbSyncResult } from '@/types/qb-links';

/** QB company (token) location -> purchase_lots.location */
export const QB_TO_RDS_LOCATION: Record<Location, string> = {
  'MedRock FL': 'MedRock Florida',
  'MedRock TN': 'MedRock Tennessee',
  'MedRock TX': 'MedRock Texas',
};

export const QB_LOCATIONS: Location[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];

/** Receiving window starts 2025-06-16; pad for bills dated slightly earlier. */
const WINDOW_START = '2025-06-01';
const MAX_MATCH_DAYS = 45;

// QBO payment-terms suffixes ("Medisca, Inc. - AutoPay Net 30") and legal noise.
const QB_VENDOR_SUFFIX = /\s*-\s*(autopay([ -]*(net\s*\d+|ach))?|ach|pay online|ramp autopay|net\s*\d+).*$/i;
const VENDOR_NOISE =
  /\b(inc|incorporated|llc|corp|corporation|co|ltd|medical|pharmaceutical|pharmaceuticals|pharmacy|products|wholesale|supplies|company)\b/g;

export function normalizeVendor(raw: string | null | undefined): string {
  let s = (raw ?? '').replace(QB_VENDOR_SUFFIX, '');
  s = s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  s = s.replace(VENDOR_NOISE, '');
  return s.replace(/\s+/g, ' ').trim();
}

// ---------- QBO entity shapes (subset we consume) ----------

interface QboRef {
  value: string;
  name?: string;
}

interface QboLinkedTxn {
  TxnId: string;
  TxnType: string;
}

interface QboLine {
  Amount?: number;
  DetailType?: string;
  LinkedTxn?: QboLinkedTxn[];
}

interface QboBill {
  Id: string;
  TxnDate: string;
  TotalAmt?: number;
  DocNumber?: string;
  VendorRef?: QboRef;
  Line?: QboLine[];
}

interface QboPurchase {
  Id: string;
  TxnDate: string;
  TotalAmt?: number;
  DocNumber?: string;
  EntityRef?: QboRef;
  Line?: QboLine[];
}

interface QboBillPayment {
  Id: string;
  TxnDate: string;
  Line?: QboLine[];
}

// ---------- internal doc model ----------

interface DocSnapshot {
  qb_doc_key: string;
  doc_type: QbDocType;
  doc_id: string;
  vendor: string | null;
  vendor_norm: string;
  txn_date: string;
  total_amount: number;
  line_amounts: number[];
  paid_date: string | null;
  doc_number: string | null;
}

interface ReceiptRow {
  receipt_id: string;
  date_received: string;
  vendor: string | null;
  total_cost: string | null;
}

function cents(n: number | undefined | null): number {
  return Math.round(((n ?? 0) as number) * 100);
}

function dayDiff(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

function docAmounts(total: number | undefined, lines: QboLine[] | undefined): number[] {
  const set = new Set<number>();
  const t = cents(total);
  if (t > 0) set.add(t);
  for (const ln of lines ?? []) {
    const a = cents(ln.Amount);
    if (a > 0) set.add(a);
  }
  return [...set];
}

async function fetchDocs(location: Location): Promise<{
  docs: DocSnapshot[];
  bills: number;
  purchases: number;
  billPayments: number;
}> {
  const where = `WHERE TxnDate >= '${WINDOW_START}'`;
  const [bills, purchases, payments] = await Promise.all([
    qbQueryAll<QboBill>(location, 'Bill', where),
    qbQueryAll<QboPurchase>(location, 'Purchase', where),
    qbQueryAll<QboBillPayment>(location, 'BillPayment', where),
  ]);

  // Bill paid date = max TxnDate of BillPayments whose lines link to it.
  const paidByBill = new Map<string, string>();
  for (const p of payments) {
    for (const line of p.Line ?? []) {
      for (const lt of line.LinkedTxn ?? []) {
        if (lt.TxnType === 'Bill') {
          const prev = paidByBill.get(lt.TxnId);
          if (!prev || p.TxnDate > prev) paidByBill.set(lt.TxnId, p.TxnDate);
        }
      }
    }
  }

  const docs: DocSnapshot[] = [];
  for (const b of bills) {
    docs.push({
      qb_doc_key: `Bill:${b.Id}`,
      doc_type: 'Bill',
      doc_id: b.Id,
      vendor: b.VendorRef?.name ?? null,
      vendor_norm: normalizeVendor(b.VendorRef?.name),
      txn_date: b.TxnDate,
      total_amount: b.TotalAmt ?? 0,
      line_amounts: docAmounts(b.TotalAmt, b.Line),
      paid_date: paidByBill.get(b.Id) ?? null,
      doc_number: b.DocNumber ?? null,
    });
  }
  for (const pu of purchases) {
    docs.push({
      qb_doc_key: `Purchase:${pu.Id}`,
      doc_type: 'Purchase',
      doc_id: pu.Id,
      vendor: pu.EntityRef?.name ?? null,
      vendor_norm: normalizeVendor(pu.EntityRef?.name),
      txn_date: pu.TxnDate,
      total_amount: pu.TotalAmt ?? 0,
      // A card/check purchase is its own payment.
      line_amounts: docAmounts(pu.TotalAmt, pu.Line),
      paid_date: pu.TxnDate,
      doc_number: pu.DocNumber ?? null,
    });
  }
  return { docs, bills: bills.length, purchases: purchases.length, billPayments: payments.length };
}

interface MatchOutcome {
  status: 'auto' | 'review' | 'unmatched';
  method: 'vendor_amount' | 'amount_unique' | 'none';
  confidence: number | null;
  qb_doc_key: string | null;
}

function matchReceipts(receipts: ReceiptRow[], docs: DocSnapshot[]): Map<string, MatchOutcome> {
  const byVendorAmt = new Map<string, DocSnapshot[]>();
  const byAmt = new Map<number, DocSnapshot[]>();
  for (const d of docs) {
    for (const a of d.line_amounts) {
      if (d.vendor_norm) {
        const k = `${d.vendor_norm}|${a}`;
        const arr = byVendorAmt.get(k);
        if (arr) arr.push(d);
        else byVendorAmt.set(k, [d]);
      }
      const arr = byAmt.get(a);
      if (arr) arr.push(d);
      else byAmt.set(a, [d]);
    }
  }

  const inWindow = (cands: DocSnapshot[] | undefined, date: string): DocSnapshot[] =>
    (cands ?? []).filter((d) => dayDiff(d.txn_date, date) <= MAX_MATCH_DAYS);
  const closest = (cands: DocSnapshot[], date: string): DocSnapshot =>
    cands.reduce((best, d) => (dayDiff(d.txn_date, date) < dayDiff(best.txn_date, date) ? d : best));

  const out = new Map<string, MatchOutcome>();
  for (const r of receipts) {
    const amt = cents(r.total_cost === null ? 0 : Number(r.total_cost));
    const v = normalizeVendor(r.vendor);

    if (v) {
      const hits = inWindow(byVendorAmt.get(`${v}|${amt}`), r.date_received);
      if (hits.length > 0) {
        out.set(r.receipt_id, {
          status: 'auto',
          method: 'vendor_amount',
          confidence: 0.95,
          qb_doc_key: closest(hits, r.date_received).qb_doc_key,
        });
        continue;
      }
    }

    const hits = inWindow(byAmt.get(amt), r.date_received);
    const uniqueDocs = new Set(hits.map((d) => d.qb_doc_key));
    if (uniqueDocs.size === 1) {
      out.set(r.receipt_id, {
        status: 'auto',
        method: 'amount_unique',
        confidence: 0.75,
        qb_doc_key: hits[0].qb_doc_key,
      });
    } else if (uniqueDocs.size > 1) {
      out.set(r.receipt_id, { status: 'review', method: 'none', confidence: null, qb_doc_key: null });
    } else {
      out.set(r.receipt_id, { status: 'unmatched', method: 'none', confidence: null, qb_doc_key: null });
    }
  }
  return out;
}

async function replaceDocSnapshot(client: PoolClient, location: Location, docs: DocSnapshot[]): Promise<void> {
  await client.query('DELETE FROM inventory.qb_documents WHERE location = $1', [location]);
  const CHUNK = 200;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: (string | number | null)[] = [];
    chunk.forEach((d, j) => {
      const base = j * 11;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::jsonb, $${base + 10}, $${base + 11})`,
      );
      params.push(
        d.qb_doc_key,
        location,
        d.doc_type,
        d.doc_id,
        d.vendor,
        d.vendor_norm || null,
        d.txn_date,
        d.total_amount,
        JSON.stringify(d.line_amounts.map((a) => a / 100)),
        d.paid_date,
        d.doc_number,
      );
    });
    await client.query(
      `INSERT INTO inventory.qb_documents
         (qb_doc_key, location, doc_type, doc_id, vendor, vendor_norm, txn_date, total_amount, line_amounts, paid_date, doc_number)
       VALUES ${values.join(', ')}
       ON CONFLICT (qb_doc_key) DO UPDATE SET
         location = EXCLUDED.location, doc_type = EXCLUDED.doc_type, doc_id = EXCLUDED.doc_id,
         vendor = EXCLUDED.vendor, vendor_norm = EXCLUDED.vendor_norm, txn_date = EXCLUDED.txn_date,
         total_amount = EXCLUDED.total_amount, line_amounts = EXCLUDED.line_amounts,
         paid_date = EXCLUDED.paid_date, doc_number = EXCLUDED.doc_number, synced_at = now()`,
      params,
    );
  }
}

/**
 * Full sync for one location: snapshot QBO docs, auto-match receipts, upsert
 * links. Existing manual/rejected decisions are preserved.
 */
export async function syncQbLinks(location: Location): Promise<QbSyncResult> {
  const rdsLocation = QB_TO_RDS_LOCATION[location];
  const { docs, bills, purchases, billPayments } = await fetchDocs(location);

  const pool = getRdsPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await replaceDocSnapshot(client, location, docs);

    const receiptsRes = await client.query<ReceiptRow>(
      `SELECT receipt_id, date_received::text AS date_received, vendor, total_cost::text AS total_cost
       FROM inventory.purchase_lots
       WHERE location = $1 AND receipt_id NOT LIKE 'OB|%'`,
      [rdsLocation],
    );
    const receipts = receiptsRes.rows;
    const outcomes = matchReceipts(receipts, docs);

    const counts: Record<'auto' | 'review' | 'unmatched', number> = { auto: 0, review: 0, unmatched: 0 };
    const values: Record<'auto' | 'review' | 'unmatched', number> = { auto: 0, review: 0, unmatched: 0 };

    const CHUNK = 200;
    for (let i = 0; i < receipts.length; i += CHUNK) {
      const chunk = receipts.slice(i, i + CHUNK);
      const rows: string[] = [];
      const params: (string | number | null)[] = [];
      chunk.forEach((r, j) => {
        const o = outcomes.get(r.receipt_id);
        if (!o) return;
        const cost = r.total_cost === null ? 0 : Number(r.total_cost);
        counts[o.status] += 1;
        values[o.status] += cost;
        const base = j * 7;
        rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
        params.push(
          r.receipt_id,
          rdsLocation,
          o.qb_doc_key,
          o.qb_doc_key === null ? null : cost,
          o.method,
          o.status,
          o.confidence,
        );
      });
      if (rows.length === 0) continue;
      // Never clobber human decisions.
      await client.query(
        `INSERT INTO inventory.qb_purchase_links
           (receipt_id, location, qb_doc_key, amount_matched, match_method, status, confidence)
         VALUES ${rows.join(', ')}
         ON CONFLICT (receipt_id) DO UPDATE SET
           qb_doc_key = EXCLUDED.qb_doc_key, amount_matched = EXCLUDED.amount_matched,
           match_method = EXCLUDED.match_method, status = EXCLUDED.status,
           confidence = EXCLUDED.confidence, updated_at = now()
         WHERE inventory.qb_purchase_links.status NOT IN ('manual', 'rejected')`,
        params,
      );
    }

    const preservedRes = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory.qb_purchase_links
       WHERE location = $1 AND status IN ('manual', 'rejected')`,
      [rdsLocation],
    );
    await client.query('COMMIT');

    return {
      location,
      bills,
      purchases,
      billPayments,
      receipts: receipts.length,
      counts,
      values,
      preservedDecisions: Number(preservedRes.rows[0]?.n ?? 0),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** QBO web deep link for a matched document. */
export function qbDeepLink(docType: QbDocType, docId: string): string {
  return docType === 'Bill'
    ? `https://app.qbo.intuit.com/app/bill?txnId=${docId}`
    : `https://app.qbo.intuit.com/app/expense?txnId=${docId}`;
}
