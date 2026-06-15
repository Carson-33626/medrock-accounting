import SalesTaxShell, { StatePlaceholder } from '@/components/SalesTaxShell';
import { getFiling } from '@/lib/sales-tax-filings';

export const dynamic = 'force-dynamic';

const filing = getFiling('florida/tx')!;

export default function FloridaTxSalesTaxPage() {
  return (
    <SalesTaxShell
      filing={filing}
      description={
        <p>
          The <strong>MedRock Florida</strong> entity&apos;s Texas return — sales where the selling location is MedRock
          Florida AND the patient&apos;s shipping address is in Texas. The Florida pharmacy was originally registered for
          both FL and TX, so it files TX separately from the MedRock Texas location.
        </p>
      }
    >
      <StatePlaceholder
        title="Not yet built — generator scaffolded, build-later"
        note="Data scope: Location='MedRock Florida' AND Patient State='TX'. May 2026 reference: 1,199 transactions, $78,024.59 gross, $0.00 tax collected (Rx exempt). Texas uses WebFile (Form 01-114), not a DR-15 clone — a separate generator. See docs/superpowers/specs/2026-06-15-sales-tax-filing-automation.md."
      />
    </SalesTaxShell>
  );
}
