import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getAccountMap, getEmployeeMap, upsertAccountRule, upsertEmployeeRule } from '@/lib/payroll/store';
import { POSTABLE_ENTITIES } from '@/lib/payroll/entity';
import type { AccountMapRule, EmployeeMapRule, Entity } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type MappingsPostBody =
  | { kind: 'account'; rule: AccountMapRule }
  | { kind: 'employee'; rule: EmployeeMapRule };

function isEntity(value: string): value is Entity {
  return (POSTABLE_ENTITIES as string[]).includes(value);
}

/** GET /api/payroll/mappings?entity= — list account + employee mapping rules for one entity. */
export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const entity = request.nextUrl.searchParams.get('entity');
    if (!entity || !isEntity(entity)) {
      return NextResponse.json({ error: 'entity query param is required and must be a valid Entity' }, { status: 400 });
    }

    const [accountMap, employeeMap] = await Promise.all([getAccountMap(entity), getEmployeeMap(entity)]);
    return NextResponse.json({ accountMap, employeeMap });
  } catch (error) {
    console.error('[payroll/mappings GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load payroll mappings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST /api/payroll/mappings { kind, rule } — upsert one account or employee mapping rule. */
export async function POST(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const body = (await request.json()) as MappingsPostBody;

    if (body.kind === 'account') {
      if (!body.rule || typeof body.rule !== 'object') {
        return NextResponse.json({ error: 'rule is required' }, { status: 400 });
      }
      await upsertAccountRule(body.rule);
      return NextResponse.json({ ok: true });
    }

    if (body.kind === 'employee') {
      if (!body.rule || typeof body.rule !== 'object') {
        return NextResponse.json({ error: 'rule is required' }, { status: 400 });
      }
      await upsertEmployeeRule(body.rule);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "kind must be 'account' or 'employee'" }, { status: 400 });
  } catch (error) {
    console.error('[payroll/mappings POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to upsert payroll mapping rule';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
