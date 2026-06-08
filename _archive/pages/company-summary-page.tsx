import { CompanySummaryDashboard } from '@/components/CompanySummaryDashboard';
import { requireAdmin } from '@/lib/auth';

export const metadata = {
  title: 'Company Summary - AMY',
  description: 'Executive-level financial summary by location',
};

export default async function CompanySummaryPage() {
  // Require admin access
  await requireAdmin();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 p-4 md:p-8">
      <CompanySummaryDashboard />
    </div>
  );
}
