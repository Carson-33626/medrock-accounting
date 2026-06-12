import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { normalizeVendor } from '@/lib/qb-links';
import type { QbCandidateRow, QbCandidatesResponse, QbDocumentRow } from '@/types/qb-links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Candidate docs for the manual picker: same location, ±60 days, scored by
 *  exact-amount hit > vendor match > date proximity. */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const receiptId = searchParams.get('receipt_id');
    if (!receiptId) {
      return NextResponse.json({ error: 'receipt_id is required' }, { status: 400 });
    }

    const pool = getRdsPool();
    const receiptRes = await pool.query<{
      location: string;
      date_received: string;
      vendor: string | null;
      product_name: string | null;
      total_cost: number;
    }>(
      `SELECT location, date_received::text AS date_received, vendor, product_name,
              total_cost::float8 AS total_cost
       FROM inventory.purchase_lots WHERE receipt_id = $1`,
      [receiptId],
    );
    if (receiptRes.rows.length === 0) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }
    const receipt = receiptRes.rows[0];

    // qb_documents.location uses the QB company key; purchase_lots uses the long form.
    const RDS_TO_QB_LOCATION: Record<string, string> = {
      'MedRock Florida': 'MedRock FL',
      'MedRock Tennessee': 'MedRock TN',
      'MedRock Texas': 'MedRock TX',
    };
    const qbLocation = RDS_TO_QB_LOCATION[receipt.location] ?? receipt.location;

    const docsRes = await pool.query<QbDocumentRow>(
      `SELECT qb_doc_key, location, doc_type, doc_id, vendor, vendor_norm,
              txn_date::text AS txn_date, total_amount::float8 AS total_amount,
              line_amounts, paid_date::text AS paid_date, doc_number
       FROM inventory.qb_documents
       WHERE location = $1
         AND txn_date BETWEEN $2::date - 60 AND $2::date + 60`,
      [qbLocation, receipt.date_received],
    );

    const vnorm = normalizeVendor(receipt.vendor);
    const amount = Math.round(receipt.total_cost * 100);
    const scored: QbCandidateRow[] = docsRes.rows.map((d) => {
      const daysApart = Math.abs(
        (Date.parse(d.txn_date) - Date.parse(receipt.date_received)) / 86_400_000,
      );
      const amounts = d.line_amounts.map((a) => Math.round(a * 100));
      return {
        ...d,
        days_apart: Math.round(daysApart),
        amount_exact: amounts.includes(amount),
        vendor_match: vnorm !== '' && d.vendor_norm === vnorm,
      };
    });

    scored.sort((a, b) => {
      if (a.amount_exact !== b.amount_exact) return a.amount_exact ? -1 : 1;
      if (a.vendor_match !== b.vendor_match) return a.vendor_match ? -1 : 1;
      return a.days_apart - b.days_apart;
    });

    const body: QbCandidatesResponse = {
      receipt_id: receiptId,
      receipt,
      candidates: scored.filter((c) => c.amount_exact || c.vendor_match).slice(0, 40),
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error('Error fetching qb-link candidates:', error);
    return NextResponse.json({ error: 'Failed to load candidates' }, { status: 500 });
  }
}
