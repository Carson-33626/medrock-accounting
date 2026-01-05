import { requireAdmin, getCurrentUser } from '@/lib/auth';
import { getUserById } from '@/lib/user-actions';
import { EditUserForm } from '@/components/admin/EditUserForm';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

interface EditUserPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditUserPage({ params }: EditUserPageProps) {
  await requireAdmin();
  const currentUser = await getCurrentUser();
  const { id } = await params;

  const user = await getUserById(id);

  if (!user) {
    notFound();
  }

  return (
    <div className="p-8">
      <EditUserForm user={user} currentUserRole={currentUser?.role || 'user'} />
    </div>
  );
}
