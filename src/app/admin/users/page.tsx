import { Suspense } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { requireAdmin, getCurrentUser } from '@/lib/auth';
import { getUsers } from '@/lib/user-actions';
import { UsersTable } from '@/components/admin/UsersTable';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  await requireAdmin();
  const currentUser = await getCurrentUser();
  const users = await getUsers();

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">User Management</h1>
          <p className="text-gray-500 dark:text-slate-400 mt-1">
            Manage user accounts and permissions
          </p>
        </div>
        <Link
          href="/admin/users/create"
          className="inline-flex items-center gap-2 px-4 py-2 text-white rounded-lg font-medium transition-colors hover:opacity-90"
          style={{ backgroundColor: '#5e3b8d' }}
        >
          <UserPlus className="h-4 w-4" />
          Add User
        </Link>
      </div>

      <Suspense fallback={
        <div className="flex items-center justify-center p-8">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      }>
        <UsersTable users={users} currentUserRole={currentUser?.role || 'user'} />
      </Suspense>
    </div>
  );
}
