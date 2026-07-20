import { redirect } from 'next/navigation';
import DrugCodingViewer, { type DrugRow } from '@/components/DrugCodingViewer';
import { getAdminClient } from '@/lib/supabase-admin';
import { getCurrentUser } from '@/lib/auth';

// Reads from Supabase at request time (NDC is joined live in the view).
export const dynamic = 'force-dynamic';

interface ViewRow {
  product_id: string;
  drug_name: string;
  sort: string | null;
  drug_form: string | null;
  drug_units: string | null;
  qb_category: string | null;
  ndc: string | null;
}

export default async function Home() {
  // NOTE (task 7 / deposit portal): `/` is not in middleware's AUTH_ONLY_EXACT
  // list, so the `accounting` app-slug entitlement check already runs in
  // middleware.ts before this Server Component ever executes. A user without
  // that entitlement gets middleware's 403 page and never reaches this code.
  // getCurrentUser() (lib/auth.ts) only validates the Supabase session/profile
  // — it has no knowledge of the accounting app-slug, since that check exists
  // solely as the auth-service fetch inside middleware. So this guard can only
  // ever catch "no session at all", not "authenticated but no accounting
  // access" — those two are NOT the same condition here, and the latter is
  // already unreachable by the time we're in this function. See the task-7
  // report for the full explanation; flagging rather than fabricating a
  // deeper entitlement check that doesn't exist elsewhere in the codebase.
  const user = await getCurrentUser();
  if (!user) redirect('/deposits');

  let rows: DrugRow[] = [];
  let loadError: string | null = null;

  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from('accounting_drug_coding_view')
      .select('product_id, drug_name, sort, drug_form, drug_units, qb_category, ndc')
      .order('drug_name');

    if (error) {
      loadError = error.message;
    } else {
      const view = (data ?? []) as ViewRow[];
      rows = view.map((r) => ({
        id: r.product_id,
        name: r.drug_name,
        sort: r.sort ?? '',
        form: r.drug_form ?? '',
        units: r.drug_units ?? '',
        category: r.qb_category ?? '',
        ndc: r.ndc,
      }));
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'Failed to load drug coding data';
  }

  return <DrugCodingViewer rows={rows} loadError={loadError} />;
}
