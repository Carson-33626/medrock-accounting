import SalesTaxShell from '@/components/SalesTaxShell';
import SalesTaxFL from '@/components/SalesTaxFL';

export const dynamic = 'force-dynamic';

export default function FloridaSalesTaxPage() {
  return (
    <SalesTaxShell state="Florida">
      <SalesTaxFL />
    </SalesTaxShell>
  );
}
