import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import type { QbLinkRow, QbLinksResponse, QbStatusTotal } from '@/types/qb-links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUSES = new Set(['auto', 'review', 'manual', 'rejected', 'unmatched', 'unsynced']);

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const location = searchParams.get('location');
    const status = searchParams.get('status');
    const search = (searchParams.get('search') ?? '').trim();
    const limit = Math.min(Number(searchParams.get('limit') ?? 50) || 50, 200);
    const offset = Math.max(Number(searchParams.get('offset') ?? 0) || 0, 0);

    const pool = getRdsPool();
    const params: (string | number)[] = [];
    const conditions: string[] = [`p.receipt_id NOT LIKE 'OB|%'`];
    if (location && location !== 'all') {
      params.push(location);
      conditions.push(`p.location = $${params.length}`);
    }
    if (status && status !== 'all' && STATUSES.has(status)) {
      params.push(status);
      conditions.push(`COALESCE(l.status, 'unsynced') = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(p.product_name ILIKE $${params.length} OR p.vendor ILIKE $${params.length} OR d.vendor ILIKE $${params.length})`,
      );
    }
    const where = conditions.join(' AND ');

    const baseJoin = `
      FROM inventory.purchase_lots p
      LEFT JOIN inventory.qb_purchase_links l ON l.receipt_id = p.receipt_id
      LEFT JOIN inventory.qb_documents d ON d.qb_doc_key = l.qb_doc_key`;

    const rowsRes = await pool.query<QbLinkRow & { total_rows: string }>(
      `SELECT p.receipt_id, p.location, p.date_received::text AS date_received,
              p.vendor, p.product_name, p.total_cost::float8 AS total_cost,
              COALESCE(l.status, 'unsynced') AS status,
              l.match_method, l.confidence::float8 AS confidence,
              l.qb_doc_key, d.doc_type, d.doc_id,
              d.vendor AS qb_vendor, d.txn_date::text AS qb_txn_date,
              d.paid_date::text AS qb_paid_date, d.total_amount::float8 AS qb_total,
              l.decided_by, l.notes,
              count(*) OVER ()::text AS total_rows
       ${baseJoin}
       WHERE ${where}
       ORDER BY CASE COALESCE(l.status, 'unsynced')
                  WHEN 'review' THEN 0 WHEN 'unmatched' THEN 1 WHEN 'unsynced' THEN 2
                  WHEN 'auto' THEN 3 WHEN 'manual' THEN 4 ELSE 5 END,
                p.total_cost DESC NULLS LAST, p.date_received DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    // Status totals over the location filter only (not status/search), so the
    // summary chips stay stable while drilling in.
    const totalsParams: (string | number)[] = [];
    let totalsWhere = `p.receipt_id NOT LIKE 'OB|%'`;
    if (location && location !== 'all') {
      totalsParams.push(location);
      totalsWhere += ` AND p.location = $${totalsParams.length}`;
    }
    const totalsRes = await pool.query<{ status: QbStatusTotal['status']; receipts: string; value: string }>(
      `SELECT COALESCE(l.status, 'unsynced') AS status,
              count(*)::text AS receipts, COALESCE(sum(p.total_cost), 0)::text AS value
       FROM inventory.purchase_lots p
       LEFT JOIN inventory.qb_purchase_links l ON l.receipt_id = p.receipt_id
       WHERE ${totalsWhere}
       GROUP BY 1`,
      totalsParams,
    );

    const syncRes = await pool.query<{ location: string; synced_at: string | null }>(
      `SELECT location, max(synced_at)::text AS synced_at FROM inventory.qb_documents GROUP BY location`,
    );
    const lastSync: Record<string, string | null> = {
      'MedRock FL': null,
      'MedRock TN': null,
      'MedRock TX': null,
    };
    for (const r of syncRes.rows) lastSync[r.location] = r.synced_at;

    const total = rowsRes.rows.length > 0 ? Number(rowsRes.rows[0].total_rows) : 0;
    const rows: QbLinkRow[] = rowsRes.rows.map((r) => ({
      receipt_id: r.receipt_id,
      location: r.location,
      date_received: r.date_received,
      vendor: r.vendor,
      product_name: r.product_name,
      total_cost: r.total_cost,
      status: r.status,
      match_method: r.match_method,
      confidence: r.confidence,
      qb_doc_key: r.qb_doc_key,
      doc_type: r.doc_type,
      doc_id: r.doc_id,
      qb_vendor: r.qb_vendor,
      qb_txn_date: r.qb_txn_date,
      qb_paid_date: r.qb_paid_date,
      qb_total: r.qb_total,
      decided_by: r.decided_by,
      notes: r.notes,
    }));

    const totals: QbStatusTotal[] = totalsRes.rows.map((r) => ({
      status: r.status,
      receipts: Number(r.receipts),
      value: Number(r.value),
    }));

    const body: QbLinksResponse = { rows, totals, total, limit, offset, lastSync };
    return NextResponse.json(body);
  } catch (error) {
    console.error('Error fetching qb-links:', error);
    return NextResponse.json({ error: 'Failed to load QB links' }, { status: 500 });
  }
}
