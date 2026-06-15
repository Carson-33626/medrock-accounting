import SalesTaxShell, { StatePlaceholder } from '@/components/SalesTaxShell';
import { getFiling } from '@/lib/sales-tax-filings';

export const dynamic = 'force-dynamic';

const filing = getFiling('nc')!;

export default function NorthCarolinaSalesTaxPage() {
  return (
    <SalesTaxShell
      filing={filing}
      description={
        <p>
          <strong>Legacy registration</strong> from the prior accountant — outside the current FL/TX/TN model. Keep
          filing (even $0) until the North Carolina registration is formally closed.
        </p>
      }
    >
      <StatePlaceholder
        title="North Carolina — monthly filing (legacy)"
        note="Filed via scripts/process_nc_tax_report.py (E-500 + E-536 schedule, Article 44 counties, transit tax). Not migrated to this page. Pending decision: retire (close the registration) or migrate onto the LifeFile feed."
      />
    </SalesTaxShell>
  );
}
