import { requireAdmin, getCurrentUser } from '@/lib/auth';
import { CreateUserForm } from '@/components/admin/CreateUserForm';

export const dynamic = 'force-dynamic';

export default async function CreateUserPage() {
  await requireAdmin();
  const currentUser = await getCurrentUser();

  return (
    <div className="p-8">
      <CreateUserForm currentUserRole={currentUser?.role || 'user'} />
    </div>
  );
}
