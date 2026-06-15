import SalesTaxShell from '@/components/SalesTaxShell';
import SalesTaxTX from '@/components/SalesTaxTX';
import { getFiling } from '@/lib/sales-tax-filings';

export const dynamic = 'force-dynamic';

const filing = getFiling('florida/tx')!;

export default function FloridaTxSalesTaxPage() {
  return (
    <SalesTaxShell
      filing={filing}
      description={
        <p>
          The <strong>MedRock Florida</strong> entity&apos;s Texas return (MEDROCK PHARMACY LLC, taxpayer 32089108859) —
          sales where the selling location is MedRock Florida AND the patient&apos;s shipping address is in Texas. As an
          out-of-state <strong>remote seller</strong>, this files local tax at the single local use tax rate (1.75% →
          8.00% combined). Separate from the MedRock Texas entity&apos;s TX return (Texas is filed twice).
        </p>
      }
    >
      <SalesTaxTX slug="florida/tx" />
    </SalesTaxShell>
  );
}
