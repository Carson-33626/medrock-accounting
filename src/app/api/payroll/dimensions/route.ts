import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { fetchDimensions } from '@/lib/payroll/qb-journal';
import { POSTABLE_ENTITIES } from '@/lib/payroll/entity';
import type { Entity } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isEntity(value: string): value is Entity {
  return (POSTABLE_ENTITIES as string[]).includes(value);
}

/**
 * GET /api/payroll/dimensions?entity= — QuickBooks accounts/departments/classes for one
 * entity, used to populate mapping-editor dropdowns. QuickBooks may be unreachable, so a
 * fetchDimensions failure is reported as 502 (bad upstream) rather than 500.
 */
export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  const entity = request.nextUrl.searchParams.get('entity');
  if (!entity || !isEntity(entity)) {
    return NextResponse.json({ error: 'entity query param is required and must be a valid Entity' }, { status: 400 });
  }

  try {
    const refs = await fetchDimensions(entity);
    const acctNums = refs.accountNums ?? {};
    return NextResponse.json({
      // Accounts carry their QB account number (null when the account has none) — the mapping
      // dropdowns show + search on it, since the accounting team works by account number.
      accounts: Object.keys(refs.accounts).map((name) => ({ name, acctNum: acctNums[name] ?? null })),
      departments: Object.keys(refs.departments),
      classes: Object.keys(refs.classes),
    });
  } catch (error) {
    console.error('[payroll/dimensions GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load QuickBooks dimensions';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
