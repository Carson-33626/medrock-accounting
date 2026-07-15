import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getRdsPool } from '@/lib/rds';
import { decryptSensitive } from '@/lib/payroll/crypto';
import type { SensitiveRow } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface DrilldownRow {
  row_key: string;
  position_id: string;
  name: string;
  pay_date: string;
  pay_group: string;
  sensitive_encrypted: string;
}

/**
 * GET /api/payroll/drilldown?rowKey= — re-decrypt ONE source row on demand for an
 * authenticated user. This is the ONLY route allowed to return raw decrypted
 * per-employee detail. The decrypted values are NEVER logged and NEVER persisted —
 * they are read fresh from source.payroll_history, decrypted server-side, and
 * returned directly in the response.
 */
export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const rowKey = request.nextUrl.searchParams.get('rowKey');
    if (!rowKey) {
      return NextResponse.json({ error: 'rowKey query param is required' }, { status: 400 });
    }

    const key = process.env.PAYROLL_ENC_KEY;
    if (!key) {
      return NextResponse.json({ error: 'decrypt key not configured' }, { status: 503 });
    }

    const { rows } = await getRdsPool().query<DrilldownRow>(
      `SELECT row_key, position_id, name, pay_date, pay_group, sensitive_encrypted
       FROM source.payroll_history
       WHERE row_key = $1`,
      [rowKey],
    );
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ error: 'row not found' }, { status: 404 });
    }

    // NEVER log `sensitive` — decrypted per-employee detail must not reach any log sink.
    const sensitive: SensitiveRow = decryptSensitive(row.sensitive_encrypted, key);

    return NextResponse.json({
      row_key: row.row_key,
      position_id: row.position_id,
      name: row.name,
      pay_date: row.pay_date,
      pay_group: row.pay_group,
      sensitive,
    });
  } catch (error) {
    // Log only the error message/shape — never log request/response bodies here,
    // since a thrown decrypt error could carry ciphertext but never plaintext.
    console.error('[payroll/drilldown GET]', error instanceof Error ? error.message : 'unknown error');
    const message = error instanceof Error ? error.message : 'Failed to load payroll drilldown';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
