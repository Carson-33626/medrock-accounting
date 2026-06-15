import SalesTaxShell from '@/components/SalesTaxShell';
import SalesTaxTX from '@/components/SalesTaxTX';
import { getFiling } from '@/lib/sales-tax-filings';

export const dynamic = 'force-dynamic';

const filing = getFiling('texas/tx')!;

export default function TexasTxSalesTaxPage() {
  return (
    <SalesTaxShell
      filing={filing}
      description={
        <p>
          The <strong>MedRock Texas</strong> entity&apos;s Texas return (MEDROCK TEXAS PHARMACY LLC, taxpayer
          32087811041) — sales where the selling location is MedRock Texas AND the patient&apos;s shipping address is in
          Texas. As an <strong>in-state seller</strong>, local tax is origin-sourced to its Colleyville place of business
          (1.5% city + 0.5% crime control → 8.25% combined). Separate from the MedRock Florida entity&apos;s TX return.
        </p>
      }
    >
      <SalesTaxTX slug="texas/tx" />
    </SalesTaxShell>
  );
}
