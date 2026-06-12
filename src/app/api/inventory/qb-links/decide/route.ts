import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import type { QbDecideRequest } from '@/types/qb-links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isDecideRequest(body: unknown): body is QbDecideRequest {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.receipt_id === 'string' &&
    (b.action === 'link' || b.action === 'reject' || b.action === 'reset') &&
    (b.qb_doc_key === undefined || typeof b.qb_doc_key === 'string') &&
    (b.decided_by === undefined || typeof b.decided_by === 'string') &&
    (b.notes === undefined || typeof b.notes === 'string')
  );
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    if (!isDecideRequest(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { receipt_id, action, qb_doc_key, decided_by, notes } = body;
    const pool = getRdsPool();

    const receiptRes = await pool.query<{ location: string; total_cost: number }>(
      `SELECT location, total_cost::float8 AS total_cost FROM inventory.purchase_lots WHERE receipt_id = $1`,
      [receipt_id],
    );
    if (receiptRes.rows.length === 0) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }
    const receipt = receiptRes.rows[0];

    if (action === 'reset') {
      // Drop the decision; the next sync re-auto-matches this receipt.
      await pool.query(`DELETE FROM inventory.qb_purchase_links WHERE receipt_id = $1`, [receipt_id]);
      return NextResponse.json({ ok: true, status: 'unsynced' });
    }

    if (action === 'link') {
      if (!qb_doc_key) {
        return NextResponse.json({ error: 'qb_doc_key is required for link' }, { status: 400 });
      }
      const docRes = await pool.query<{ qb_doc_key: string }>(
        `SELECT qb_doc_key FROM inventory.qb_documents WHERE qb_doc_key = $1`,
        [qb_doc_key],
      );
      if (docRes.rows.length === 0) {
        return NextResponse.json({ error: 'QB document not found (re-sync first?)' }, { status: 404 });
      }
      await pool.query(
        `INSERT INTO inventory.qb_purchase_links
           (receipt_id, location, qb_doc_key, amount_matched, match_method, status, confidence, decided_by, notes)
         VALUES ($1, $2, $3, $4, 'manual', 'manual', 1.0, $5, $6)
         ON CONFLICT (receipt_id) DO UPDATE SET
           qb_doc_key = EXCLUDED.qb_doc_key, amount_matched = EXCLUDED.amount_matched,
           match_method = 'manual', status = 'manual', confidence = 1.0,
           decided_by = EXCLUDED.decided_by, notes = EXCLUDED.notes, updated_at = now()`,
        [receipt_id, receipt.location, qb_doc_key, receipt.total_cost, decided_by ?? null, notes ?? null],
      );
      return NextResponse.json({ ok: true, status: 'manual' });
    }

    // action === 'reject': reviewed, no QB document exists for this receipt.
    await pool.query(
      `INSERT INTO inventory.qb_purchase_links
         (receipt_id, location, qb_doc_key, amount_matched, match_method, status, confidence, decided_by, notes)
       VALUES ($1, $2, NULL, NULL, 'manual', 'rejected', NULL, $3, $4)
       ON CONFLICT (receipt_id) DO UPDATE SET
         qb_doc_key = NULL, amount_matched = NULL, match_method = 'manual', status = 'rejected',
         confidence = NULL, decided_by = EXCLUDED.decided_by, notes = EXCLUDED.notes, updated_at = now()`,
      [receipt_id, receipt.location, decided_by ?? null, notes ?? null],
    );
    return NextResponse.json({ ok: true, status: 'rejected' });
  } catch (error) {
    console.error('Error deciding qb-link:', error);
    return NextResponse.json({ error: 'Failed to save decision' }, { status: 500 });
  }
}
