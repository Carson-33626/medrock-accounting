import { requireAuth } from '@/lib/auth';
import { PayrollTabs } from './components/PayrollTabs';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Payroll — MedRock Accounting',
  description: 'ADP payroll journal entry builder — draft, review, and post per-entity payroll JEs',
};

export default async function PayrollPage() {
  await requireAuth();

  return <PayrollTabs />;
}
