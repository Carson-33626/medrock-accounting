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
          Chattanooga / Hamilton Co.) — sales where the selling location is MedRock Tennessee AND the patient&apos;s
          shipping address is in Tennessee. MedRock Tennessee ships to many other states, but those are non-taxable (Rx
          exempt), so <strong>it only files in TN</strong>. Filed <strong>annually</strong> (SLS-450, due Jan 20).
        </p>
      }
    >
      <SalesTaxTN />
    </SalesTaxShell>
  );
}
