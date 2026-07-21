import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getRdsPool } from '@/lib/rds';
import { loadDraft } from '@/lib/payroll/store';
import { resolveRepTerritory, resolveDirector } from '@/lib/payroll/territory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One marketer on the loaded run whose employee-map Department is the '% Allocation'
 * inter-entity catch-all or entirely unassigned (no active employee-map row yet). */
export interface MarketerReviewItem {
  positionId: string;
  name: string;
  /** Payroll home_department (e.g. "MARKETING") — the role, straight off the payroll row. */
  role: string | null;
  /** Territory (market, e.g. "Carolina Region") from the territory snapshot; null if no rep match. */
  territory: string | null;
  /** Sales title (e.g. "Senior Territory Manager") from the territory snapshot; null if no match. */
  title: string | null;
  currentDepartment: string | null;
  currentClass: string | null;
  currentCogsOverride: boolean | null;
  employeeRuleId: number | null;
}

interface MarketerRow {
  positionId: string;
  name: string;
  role: string | null;
  currentDepartment: string | null;
  currentClass: string | null;
  currentCogsOverride: boolean | null;
  employeeRuleId: number | null;
}

interface ApiErrorBody {
  error?: string;
}

/**
 * GET /api/payroll/marketers?headerId= — marketers on the loaded run (home_department
 * ILIKE 'MARKET%') who still need a region assigned: their active employee-map Department
 * is either the '% Allocation' inter-entity catch-all or missing entirely. These are the
 * rows the Review tab's MarketerReviewPanel (the marketer counterpart to
 * UnmappedColumnsPanel) surfaces for inline reassignment to a real QB Department/region.
 *
 * Takes `headerId` (not entity/payDate/payGroup) — same identity ReviewTab already holds
 * for the loaded draft and the same shape the /api/payroll/reconcile route accepts, so the
 * run's entity/pay_date/pay_group are looked up server-side via loadDraft rather than
 * trusted from the client.
 *
 * PLAINTEXT ONLY: selects position_id, name — both plaintext columns on
 * source.payroll_history. Never touches sensitive_encrypted, never decrypts, never returns
 * dollar amounts. Mirrors the plaintext-only discipline in
 * scripts/payroll/employee-map-seed-data.ts (buildMarketerEmployeeMap), which is also the
 * source of the '% Allocation' catch-all convention this route surfaces for review.
 */
export async function GET(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const headerIdParam = request.nextUrl.searchParams.get('headerId');
    if (!headerIdParam) {
      return NextResponse.json({ error: 'headerId query param is required' }, { status: 400 });
    }
    const headerId = Number(headerIdParam);
    if (!Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'headerId must be a number' }, { status: 400 });
    }

    const loaded = await loadDraft(headerId);
    if (!loaded) {
      return NextResponse.json({ error: 'header not found' }, { status: 404 });
    }
    const { header } = loaded;

    const { rows } = await getRdsPool().query<MarketerRow>(
      `SELECT DISTINCT ON (ph.position_id)
              ph.position_id AS "positionId",
              ph.name AS "name",
              ph.home_department AS "role",
              pm.department_name AS "currentDepartment",
              pm.class_name AS "currentClass",
              pm.cogs_override AS "currentCogsOverride",
              pm.id AS "employeeRuleId"
       FROM source.payroll_history ph
       LEFT JOIN accounting.payroll_employee_map pm
         ON pm.entity = $1 AND pm.position_id = ph.position_id AND pm.active = true
       WHERE ph.pay_date = $2 AND ph.pay_group = $3
         AND ph.home_department ILIKE 'MARKET%'
         AND (pm.department_name = '% Allocation' OR pm.department_name IS NULL)
         -- Once an accountant confirms the assignment (incl. deliberately keeping '% Allocation'),
         -- reviewed = true drops the marketer off this worklist instead of re-flagging forever.
         AND pm.reviewed IS NOT TRUE
       ORDER BY ph.position_id`,
      [header.entity, header.pay_date, header.pay_group],
    );

    // Enrich each marketer with territory + title from the (plaintext) name -> snapshot join, so
    // the review panel shows role/territory/title. Territory reps resolve from the territory
    // snapshot; marketing leadership (directors — not territory reps) fall back to the directors
    // map (division shown as territory, leadership title). Anyone matching neither (offboarded /
    // not yet mapped) surfaces null territory/title rather than blocking — role always comes from
    // payroll home_department.
    const result: MarketerReviewItem[] = rows.map((r) => {
      const terr = resolveRepTerritory(r.name);
      if (terr) {
        return { ...r, territory: terr.market, title: terr.title ? terr.title : null };
      }
      const dir = resolveDirector(r.name);
      return { ...r, territory: dir?.division ?? null, title: dir?.title ?? null };
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[payroll/marketers GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to load marketers needing region review';
    const body: ApiErrorBody = { error: message };
    return NextResponse.json(body, { status: 500 });
  }
}
