'use server';

import { getCurrentUser } from '@/lib/auth';
import { getAdminClient } from '@/lib/supabase-admin';
import { revalidatePath } from 'next/cache';
import type { User } from '@/types/user';

/**
 * Get all users (admin only)
 */
export async function getUsers(): Promise<User[]> {
  const currentUser = await getCurrentUser();
  if (!currentUser) throw new Error('Authentication required');

  if (currentUser.role !== 'admin' && currentUser.role !== 'super_admin') {
    throw new Error('Admin access required');
  }

  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch users:', error);
    throw new Error('Failed to fetch users');
  }

  return (data || []).map(user => ({
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    phone: user.phone || null,
    role: user.role,
    departments: user.departments || [],
    is_active: user.is_active ?? true,
    must_change_password: user.must_change_password ?? false,
    created_at: user.created_at,
    updated_at: user.updated_at,
  }));
}

/**
 * Get a single user by ID
 */
export async function getUserById(userId: string): Promise<User | null> {
  const currentUser = await getCurrentUser();
  if (!currentUser) throw new Error('Authentication required');

  if (currentUser.role !== 'admin' && currentUser.role !== 'super_admin') {
    throw new Error('Admin access required');
  }

  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) {
    console.error('Failed to fetch user:', error);
    return null;
  }

  return {
    id: data.id,
    email: data.email,
    full_name: data.full_name,
    phone: data.phone || null,
    role: data.role,
    departments: data.departments || [],
    is_active: data.is_active ?? true,
    must_change_password: data.must_change_password ?? false,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

/**
 * Create a new user
 */
export async function createUser(formData: FormData) {
  const currentUser = await getCurrentUser();
  if (!currentUser) throw new Error('Authentication required');

  if (currentUser.role !== 'admin' && currentUser.role !== 'super_admin') {
    throw new Error('Admin access required');
  }

  const email = formData.get('email') as string;
  const fullName = formData.get('fullName') as string;
  const phone = formData.get('phone') as string | null;
  const role = formData.get('role') as 'admin' | 'user' | 'super_admin';
  const password = formData.get('password') as string;
  const departmentsJson = formData.get('departments') as string;
  const departments = departmentsJson ? JSON.parse(departmentsJson) : [];

  if (!email || !fullName || !role || !password) {
    throw new Error('All required fields must be provided');
  }

  // Only super admins can create other super admins
  if (role === 'super_admin' && currentUser.role !== 'super_admin') {
    throw new Error('Only super admins can create super admin accounts');
  }

  const supabase = getAdminClient();

  // Check if user already exists
  const { data: existingProfile } = await supabase
    .from('user_profiles')
    .select('email')
    .eq('email', email)
    .single();

  if (existingProfile) {
    throw new Error('A user with this email already exists');
  }

  // Create auth user
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError) {
    // Handle orphaned auth users
    if (authError.message.includes('already been registered')) {
      // Find and delete orphaned user
      const { data: listData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const orphanedUser = listData?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());

      if (orphanedUser) {
        await supabase.auth.admin.deleteUser(orphanedUser.id);

        // Retry creation
        const { data: retryUser, error: retryError } = await supabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });

        if (retryError) {
          throw new Error(`Failed to create user: ${retryError.message}`);
        }

        if (!retryUser.user) {
          throw new Error('Failed to create user account');
        }

        // Create profile for retried user
        const { error: profileError } = await supabase.from('user_profiles').insert({
          id: retryUser.user.id,
          email,
          full_name: fullName,
          phone: phone || null,
          role,
          departments,
        });

        if (profileError) {
          await supabase.auth.admin.deleteUser(retryUser.user.id);
          throw new Error(`Failed to create user profile: ${profileError.message}`);
        }

        revalidatePath('/admin/users');
        return { success: true, userId: retryUser.user.id };
      }
    }
    throw new Error(`Failed to create user: ${authError.message}`);
  }

  if (!authUser.user) {
    throw new Error('Failed to create user account');
  }

  // Create user profile
  const { error: profileError } = await supabase.from('user_profiles').insert({
    id: authUser.user.id,
    email,
    full_name: fullName,
    phone: phone || null,
    role,
    departments,
  });

  if (profileError) {
    await supabase.auth.admin.deleteUser(authUser.user.id);
    throw new Error(`Failed to create user profile: ${profileError.message}`);
  }

  revalidatePath('/admin/users');
  return { success: true, userId: authUser.user.id };
}

/**
 * Update a user
 */
export async function updateUser(userId: string, formData: FormData) {
  const currentUser = await getCurrentUser();
  if (!currentUser) throw new Error('Authentication required');

  if (currentUser.role !== 'admin' && currentUser.role !== 'super_admin') {
    throw new Error('Admin access required');
  }

  const fullName = formData.get('fullName') as string;
  const phone = formData.get('phone') as string | null;
  const role = formData.get('role') as 'admin' | 'user' | 'super_admin';
  const departmentsJson = formData.get('departments') as string;
  const departments = departmentsJson ? JSON.parse(departmentsJson) : [];

  // Only super admins can set super_admin role
  if (role === 'super_admin' && currentUser.role !== 'super_admin') {
    throw new Error('Only super admins can assign super admin role');
  }

  const supabase = getAdminClient();

  const { error } = await supabase
    .from('user_profiles')
    .update({
      full_name: fullName,
      phone: phone || null,
      role,
      departments,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) {
    throw new Error(`Failed to update user: ${error.message}`);
  }

  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${userId}/edit`);
  return { success: true };
}

/**
 * Delete a user
 */
export async function deleteUser(userId: string) {
  const currentUser = await getCurrentUser();
  if (!currentUser) throw new Error('Authentication required');

  if (currentUser.role !== 'admin' && currentUser.role !== 'super_admin') {
    throw new Error('Admin access required');
  }

  // Prevent self-deletion
  if (currentUser.id === userId) {
    throw new Error('Cannot delete your own account');
  }

  const supabase = getAdminClient();

  // Get user to check role
  const { data: targetUser } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', userId)
    .single();

  // Only super admins can delete other admins/super_admins
  if (targetUser?.role === 'super_admin' && currentUser.role !== 'super_admin') {
    throw new Error('Only super admins can delete super admin accounts');
  }

  if (targetUser?.role === 'admin' && currentUser.role !== 'super_admin') {
    throw new Error('Only super admins can delete admin accounts');
  }

  // Delete profile first
  const { error: profileError } = await supabase
    .from('user_profiles')
    .delete()
    .eq('id', userId);

  if (profileError) {
    throw new Error(`Failed to delete user profile: ${profileError.message}`);
  }

  // Delete auth user
  const { error: authError } = await supabase.auth.admin.deleteUser(userId);

  if (authError) {
    console.error('Failed to delete auth user:', authError);
    // Profile already deleted, log error but don't throw
  }

  revalidatePath('/admin/users');
  return { success: true };
}
