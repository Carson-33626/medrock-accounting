import SalesTaxShell, { StatePlaceholder } from '@/components/SalesTaxShell';

export const dynamic = 'force-dynamic';

export default function GeorgiaSalesTaxPage() {
  return (
    <SalesTaxShell state="Georgia">
      <StatePlaceholder
        title="Georgia — annual filing"
        note="Filed successfully for 2025 via scripts/process_ga_tax_report.py (county-level summary for GTC entry). Not yet migrated to this page — the LifeFile feed already carries GA county + FIPS (98.5% resolved), so a web generator like Florida's is the next step."
      />
    </SalesTaxShell>
  );
}
