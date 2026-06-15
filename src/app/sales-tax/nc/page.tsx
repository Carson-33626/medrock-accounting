import SalesTaxShell, { StatePlaceholder } from '@/components/SalesTaxShell';

export const dynamic = 'force-dynamic';

export default function NorthCarolinaSalesTaxPage() {
  return (
    <SalesTaxShell state="North Carolina">
      <StatePlaceholder
        title="North Carolina — monthly filing (due the 20th)"
        note="Filed via scripts/process_nc_tax_report.py (E-500 + E-536 schedule, Article 44 counties, transit tax). Not yet on this page — can be moved onto the feed like Florida."
      />
    </SalesTaxShell>
  );
}
