import { Suspense } from 'react';
import { Loader2, CheckCircle2, XCircle, ExternalLink, AlertCircle } from 'lucide-react';
import { requireAdmin } from '@/lib/auth';
import { QuickBooksConnectionManager } from '@/components/admin/QuickBooksConnectionManager';

export const dynamic = 'force-dynamic';

export default async function QuickBooksAdminPage() {
  await requireAdmin(); // Restrict to admin and super_admin only

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          QuickBooks Integration
        </h1>
        <p className="text-gray-500 dark:text-slate-400 mt-1">
          Connect QuickBooks Online accounts for revenue comparison and financial analytics
        </p>
      </div>

      <Suspense
        fallback={
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        }
      >
        <QuickBooksConnectionManager />
      </Suspense>

      {/* Information panel */}
      <div className="mt-8 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-6">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
              About QuickBooks Integration
            </h3>
            <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-1">
              <li>• Connect each location (FL, TN, TX) to its respective QuickBooks company</li>
              <li>• Access tokens automatically refresh every 60 minutes</li>
              <li>• Revenue data is fetched in real-time for comparison with internal records</li>
              <li>• Disconnect at any time to revoke access</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
