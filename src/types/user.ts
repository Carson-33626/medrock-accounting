/**
 * User types for AMY user management
 */

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  role: 'user' | 'admin' | 'super_admin';
  is_active: boolean;
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateUserData {
  email: string;
  fullName: string;
  phone?: string;
  role: 'user' | 'admin' | 'super_admin';
  password: string;
  sendWelcomeEmail?: boolean;
}

export interface UpdateUserData {
  fullName?: string;
  phone?: string;
  role?: 'user' | 'admin' | 'super_admin';
  is_active?: boolean;
}
