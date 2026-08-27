import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import {
  getAccountMap,
  getEmployeeMap,
  upsertAccountRule,
  upsertEmployeeRule,
  updateAccountRule,
  updateEmployeeRule,
  deleteAccountRule,
  deleteEmployeeRule,
} from '@/lib/payroll/store';
import { POSTABLE_ENTITIES } from '@/lib/payroll/entity';
import { isValidCostCenter, SELECTABLE_COST_CENTERS } from '@/lib/payroll/cost-center';
import type { AccountMapRule, EmployeeMapRule, Entity } from '@/lib/payroll/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type MappingsPostBody =
  | { kind: 'account'; rule: AccountMapRule }
  | { kind: 'employee'; rule: EmployeeMapRule };

type MappingsDeleteBody = { kind: 'account' | 'employee'; id: number };

function isEntity(value: string): value is Entity {
  return (POSTABLE_ENTITIES as string[]).includes(value);
}

/**
 * Rejects an account rule the resolver could never apply. A rule is keyed by
 * (entity, adp_column, cost_center) and `resolveLine` matches cost_center exactly or on the
 * pooled '*' — so a malformed cost_center writes a rule that never fires, leaving the column
 * permanently stuck in "new columns detected" while the accountant believes it was mapped.
 * Validated here (not just in the picker) because two separate clients write this table and
 * only one of them was ever constrained. Returns an error string, or null when the rule is fine.
 */
function accountRuleError(rule: AccountMapRule): string | null {
  if (typeof rule.entity !== 'string' || !isEntity(rule.entity)) {
    return `entity must be one of: ${POSTABLE_ENTITIES.join(', ')}`;
  }
  if (typeof rule.adpColumn !== 'string' || rule.adpColumn.trim() === '') {
    return 'adpColumn is required';
  }
  if (typeof rule.accountName !== 'string' || rule.accountName.trim() === '') {
    return 'accountName is required';
  }
  if (rule.postingType !== 'Debit' && rule.postingType !== 'Credit') {
    return "postingType must be 'Debit' or 'Credit'";
  }
  if (typeof rule.costCenter !== 'string' || !isValidCostCenter(rule.costCenter)) {
    return `costCenter ${JSON.stringify(rule.costCenter)} is not a valid cost center — a rule with this value would never match any payroll row. Use one of: ${SELECTABLE_COST_CENTERS.join(', ')}`;
  }
  return null;
}

/** GET /api/payroll/mappings?entity= — list account + employee mapping rules for one entity. */
export async function GET(request: NextRequest) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();

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

/**
 * POST /api/payroll/mappings { kind, rule } — create or update one account or employee
 * mapping rule. When rule.id is a number, the edit is applied by surrogate key (UPDATE ...
 * WHERE id=$1) so changing account_name/posting_type/adp_column (etc.) cannot re-insert a
 * duplicate active row via the natural-key ON CONFLICT path. When rule.id is absent, the
 * natural-key upsert is used (idempotent seed path for brand-new rules).
 */
export async function POST(request: NextRequest) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();

  try {
    const body = (await request.json()) as MappingsPostBody;

    if (body.kind === 'account') {
      if (!body.rule || typeof body.rule !== 'object') {
        return NextResponse.json({ error: 'rule is required' }, { status: 400 });
      }
      const invalid = accountRuleError(body.rule);
      if (invalid) {
        return NextResponse.json({ error: invalid }, { status: 400 });
      }
      if (typeof body.rule.id === 'number') {
        await updateAccountRule(body.rule.id, body.rule);
        return NextResponse.json({ ok: true, id: body.rule.id });
      }
      const id = await upsertAccountRule(body.rule);
      return NextResponse.json({ ok: true, id });
    }

    if (body.kind === 'employee') {
      if (!body.rule || typeof body.rule !== 'object') {
        return NextResponse.json({ error: 'rule is required' }, { status: 400 });
      }
      if (typeof body.rule.id === 'number') {
        await updateEmployeeRule(body.rule.id, body.rule);
        return NextResponse.json({ ok: true, id: body.rule.id });
      }
      const id = await upsertEmployeeRule(body.rule);
      return NextResponse.json({ ok: true, id });
    }

    return NextResponse.json({ error: "kind must be 'account' or 'employee'" }, { status: 400 });
  } catch (error) {
    console.error('[payroll/mappings POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to upsert payroll mapping rule';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/payroll/mappings { kind, id } — delete one account or employee mapping rule by surrogate id. */
export async function DELETE(request: NextRequest) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();

  try {
    const body = (await request.json()) as MappingsDeleteBody;

    if (body.kind !== 'account' && body.kind !== 'employee') {
      return NextResponse.json({ error: "kind must be 'account' or 'employee'" }, { status: 400 });
    }
    if (typeof body.id !== 'number') {
      return NextResponse.json({ error: 'id is required and must be a number' }, { status: 400 });
    }

    if (body.kind === 'account') {
      await deleteAccountRule(body.id);
    } else {
      await deleteEmployeeRule(body.id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[payroll/mappings DELETE]', error);
    const message = error instanceof Error ? error.message : 'Failed to delete payroll mapping rule';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
