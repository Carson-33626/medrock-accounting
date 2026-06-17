import SalesTaxShell from '@/components/SalesTaxShell';
import SalesTaxTN from '@/components/SalesTaxTN';
import { getFiling } from '@/lib/sales-tax-filings';

export const dynamic = 'force-dynamic';

const filing = getFiling('tennessee/tn')!;

export default function TennesseeTnSalesTaxPage() {
  return (
    <SalesTaxShell
      filing={filing}
      description={
        <p>
          The <strong>MedRock Tennessee</strong> entity&apos;s Tennessee return (MEDROCK TN LLC, account 1002172027-SLC,
          Chattanooga / Hamilton Co.). Gross Sales is the entity&apos;s <strong>total sales across every ship-to
          state</strong> (TN is MedRock&apos;s catch-all dispensing pharmacy); out-of-state sales and exempt Rx are then
          deducted on Schedule A, leaving the TN-taxable items. MedRock Tennessee <strong>only files in TN</strong>.
          Filed <strong>annually</strong> (SLS-450, due Jan 20).
        </p>
      }
    >
      <SalesTaxTN />
    </SalesTaxShell>
  );
}
