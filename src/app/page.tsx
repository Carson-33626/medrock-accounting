import DrugCodingViewer, { type DrugRow } from '@/components/DrugCodingViewer';
import { getAdminClient } from '@/lib/supabase-admin';

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
