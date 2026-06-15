import SalesTaxShell, { StatePlaceholder } from '@/components/SalesTaxShell';
import { getFiling } from '@/lib/sales-tax-filings';

export const dynamic = 'force-dynamic';

const filing = getFiling('texas/tx')!;

export default function TexasTxSalesTaxPage() {
  return (
    <SalesTaxShell
      filing={filing}
      description={
        <p>
          The <strong>MedRock Texas</strong> entity&apos;s Texas return — sales where the selling location is MedRock
          Texas AND the patient&apos;s shipping address is in Texas. This is separate from the MedRock Florida entity&apos;s
          TX return (Texas is filed twice — once per entity/permit).
        </p>
      }
    >
      <StatePlaceholder
        title="Not yet built — generator scaffolded, build-later"
        note="Data scope: Location='MedRock Texas' AND Patient State='TX'. May 2026 reference: 2,130 transactions, $142,947.74 gross, $2.48 tax collected. Texas uses WebFile (Form 01-114), not a DR-15 clone — a separate generator. See docs/superpowers/specs/2026-06-15-sales-tax-filing-automation.md."
      />
    </SalesTaxShell>
  );
}
