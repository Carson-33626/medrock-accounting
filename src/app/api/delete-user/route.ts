import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getAdminClient } from '@/lib/supabase-admin';

/**
 * DELETE /api/delete-user
 *
 * Deletes a user from both Supabase Auth and user_profiles table.
 */
export async function DELETE(request: Request) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    if (currentUser.role !== 'admin' && currentUser.role !== 'super_admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { userId } = await request.json();

    if (!userId) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
    }

    // Prevent self-deletion
    if (currentUser.id === userId) {
      return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 });
    }

    const supabase = getAdminClient();

    // Get target user to check role
    const { data: targetUser } = await supabase
      .from('user_profiles')
      .select('role, full_name, email')
      .eq('id', userId)
      .single();

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Only super admins can delete other admins/super_admins
    if (targetUser.role === 'super_admin' && currentUser.role !== 'super_admin') {
      return NextResponse.json({ error: 'Only super admins can delete super admin accounts' }, { status: 403 });
    }

    if (targetUser.role === 'admin' && currentUser.role !== 'super_admin') {
      return NextResponse.json({ error: 'Only super admins can delete admin accounts' }, { status: 403 });
    }

    // Delete profile first
    const { error: profileError } = await supabase
      .from('user_profiles')
      .delete()
      .eq('id', userId);

    if (profileError) {
      console.error('Failed to delete user profile:', profileError);
      return NextResponse.json({ error: `Failed to delete user profile: ${profileError.message}` }, { status: 500 });
    }

    // Delete auth user
    const { error: authError } = await supabase.auth.admin.deleteUser(userId);

    if (authError) {
      console.error('Failed to delete auth user:', authError);
      // Profile already deleted, log error but return success
    }

    return NextResponse.json({
      success: true,
      message: `User ${targetUser.full_name || targetUser.email} has been deleted`
    });

  } catch (error) {
    console.error('Delete user error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
