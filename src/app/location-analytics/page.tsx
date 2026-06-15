import { LocationAnalytics } from '@/components/LocationAnalytics';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Location Analytics — MedRock Accounting',
  description: 'Executive P&L by location, cross-checked against LifeFile sales and FIFO inventory',
};

export default async function LocationAnalyticsPage() {
  // Financial P&L — admin only (redirects non-admins).
  await requireAdmin();

  return <LocationAnalytics />;
}
