import SalesTaxShell, { StatePlaceholder } from '@/components/SalesTaxShell';
import { getFiling } from '@/lib/sales-tax-filings';

export const dynamic = 'force-dynamic';

const filing = getFiling('tennessee/tn')!;

export default function TennesseeTnSalesTaxPage() {
  return (
    <SalesTaxShell
      filing={filing}
      description={
        <p>
          The <strong>MedRock Tennessee</strong> entity&apos;s Tennessee return — sales where the selling location is
          MedRock Tennessee AND the patient&apos;s shipping address is in Tennessee. MedRock Tennessee ships to many other
          states, but those are non-taxable (Rx exempt), so <strong>it only files in TN</strong>.
        </p>
      }
    >
      <StatePlaceholder
        title="Not yet built — generator scaffolded, build-later"
        note="Data scope: Location='MedRock Tennessee' AND Patient State='TN'. May 2026 reference: 3,625 transactions, $222,889.50 gross, $7.40 tax collected. Tennessee files form SLS-450 — a separate generator from FL's DR-15. See docs/superpowers/specs/2026-06-15-sales-tax-filing-automation.md."
      />
    </SalesTaxShell>
  );
}
