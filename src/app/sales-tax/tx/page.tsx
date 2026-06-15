import SalesTaxShell, { StatePlaceholder } from '@/components/SalesTaxShell';

export const dynamic = 'force-dynamic';

export default function TexasSalesTaxPage() {
  return (
    <SalesTaxShell state="Texas">
      <StatePlaceholder
        title="Texas — annual filing"
        note="Not yet built. The feed carries TX transactions (from Feb 2026); a generator can be added when Texas filing is scoped."
      />
    </SalesTaxShell>
  );
}
