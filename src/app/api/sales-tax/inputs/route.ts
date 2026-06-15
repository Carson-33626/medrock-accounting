import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { getCurrentUser } from '@/lib/auth';
import { getFiling } from '@/lib/sales-tax-filings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SavedInputs {
  taxablePurchases: number | null;
  salesBasisOverride: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

// The `month` column is really a period key: monthly filings use YYYY-MM, quarterly use YYYY-Qn.
function isValidMonth(m: string | null): m is string {
  return !!m && (/^\d{4}-\d{2}$/.test(m) || /^\d{4}-Q[1-4]$/.test(m));
}

/** GET /api/sales-tax/inputs?slug=florida/fl&month=YYYY-MM — load saved inputs (or nulls). */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const slug = searchParams.get('slug');
    const month = searchParams.get('month');
    if (!slug || !getFiling(slug)) {
      return NextResponse.json({ error: 'unknown filing slug' }, { status: 400 });
    }
    if (!isValidMonth(month)) {
      return NextResponse.json({ error: 'month=YYYY-MM required' }, { status: 400 });
    }

    const pool = getRdsPool();
    const res = await pool.query<{
      taxable_purchases: string | null;
      sales_basis_override: string | null;
      updated_at: string | null;
      updated_by: string | null;
    }>(
      `SELECT taxable_purchases, sales_basis_override, updated_at::text, updated_by
       FROM accounting.sales_tax_filing_inputs
       WHERE filing_slug = $1 AND month = $2`,
      [slug, month],
    );

    const row = res.rows[0];
    const out: SavedInputs = {
      taxablePurchases: row?.taxable_purchases != null ? Number(row.taxable_purchases) : null,
      salesBasisOverride: row?.sales_basis_override != null ? Number(row.sales_basis_override) : null,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
    return NextResponse.json(out);
  } catch (error) {
    console.error('[sales-tax/inputs GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load inputs';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface SaveBody {
  slug?: string;
  month?: string;
  taxablePurchases?: number | null;
  salesBasisOverride?: number | null;
}

/** POST /api/sales-tax/inputs — upsert saved inputs for (slug, month). */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SaveBody;
    const { slug, month } = body;
    if (!slug || !getFiling(slug)) {
      return NextResponse.json({ error: 'unknown filing slug' }, { status: 400 });
    }
    if (!isValidMonth(month ?? null)) {
      return NextResponse.json({ error: 'month=YYYY-MM required' }, { status: 400 });
    }

    const norm = (v: number | null | undefined): number | null =>
      v === null || v === undefined || !Number.isFinite(v) ? null : v;
    const taxablePurchases = norm(body.taxablePurchases);
    const salesBasisOverride = norm(body.salesBasisOverride);

    const user = await getCurrentUser();
    const updatedBy = user?.email ?? 'unknown';

    const pool = getRdsPool();
    const res = await pool.query<{ updated_at: string }>(
      `INSERT INTO accounting.sales_tax_filing_inputs
         (filing_slug, month, taxable_purchases, sales_basis_override, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (filing_slug, month) DO UPDATE SET
         taxable_purchases    = EXCLUDED.taxable_purchases,
         sales_basis_override = EXCLUDED.sales_basis_override,
         updated_at           = now(),
         updated_by           = EXCLUDED.updated_by
       RETURNING updated_at::text`,
      [slug, month, taxablePurchases, salesBasisOverride, updatedBy],
    );

    const saved: SavedInputs = {
      taxablePurchases,
      salesBasisOverride,
      updatedAt: res.rows[0]?.updated_at ?? null,
      updatedBy,
    };
    return NextResponse.json({ ok: true, ...saved });
  } catch (error) {
    console.error('[sales-tax/inputs POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to save inputs';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
