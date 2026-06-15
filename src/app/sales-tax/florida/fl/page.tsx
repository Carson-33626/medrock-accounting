import SalesTaxShell from '@/components/SalesTaxShell';
import SalesTaxFL from '@/components/SalesTaxFL';
import { getFiling } from '@/lib/sales-tax-filings';

export const dynamic = 'force-dynamic';

const filing = getFiling('florida/fl')!;

export default function FloridaFlSalesTaxPage() {
  return (
    <SalesTaxShell
      filing={filing}
      description={
        <>
          <p className="font-semibold text-purple-800">
            For the <span className="underline decoration-purple-400">MedRock Florida</span> location only.
          </p>
          <p className="mt-1">
            Includes <strong>only</strong> sales where the <strong>selling location is MedRock Florida</strong> AND the{' '}
            <strong>patient&apos;s shipping address is in Florida</strong> (ship-to state = FL). This is destination-based:
            a Florida sale means the medication went to a Florida patient.
          </p>
          <p className="mt-1">
            It does <strong>NOT</strong> include: the Tennessee or Texas locations, or MedRock Florida orders shipped to
            patients <strong>outside</strong> Florida — those belong to other returns (e.g. MedRock&nbsp;Florida →
            Texas and MedRock&nbsp;Texas → Texas are two separate Texas filings).
          </p>
        </>
      }
    >
      <SalesTaxFL />
    </SalesTaxShell>
  );
}
