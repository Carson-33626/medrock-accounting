import SalesTaxShell, { StatePlaceholder } from '@/components/SalesTaxShell';
import { getFiling } from '@/lib/sales-tax-filings';

export const dynamic = 'force-dynamic';

const filing = getFiling('ga')!;

export default function GeorgiaSalesTaxPage() {
  return (
    <SalesTaxShell
      filing={filing}
      description={
        <p>
          <strong>Legacy registration</strong> from the prior accountant — outside the current FL/TX/TN model. Keep
          filing (even $0) until the Georgia registration is formally closed.
        </p>
      }
    >
      <StatePlaceholder
        title="Georgia — annual filing (legacy)"
        note="Filed successfully for 2025 via scripts/process_ga_tax_report.py (county-level summary for GTC entry). Not migrated to this page. Pending decision: retire (close the registration) or migrate onto the LifeFile feed."
      />
    </SalesTaxShell>
  );
}
