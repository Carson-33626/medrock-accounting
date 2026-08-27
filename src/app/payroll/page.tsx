import { requireManager } from '@/lib/auth';
import { PayrollTabs } from './components/PayrollTabs';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Journal Entries — MedRock Accounting',
  description:
    'Journal entry builder — draft, review, and post per-entity payroll JEs and month-end allocation JEs',
};

export default async function PayrollPage() {
  await requireManager();

  return <PayrollTabs />;
}
