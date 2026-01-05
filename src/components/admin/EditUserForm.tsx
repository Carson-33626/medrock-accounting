'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateUser } from '@/lib/user-actions';
import { UserCog, Loader2, Phone, ArrowLeft, Save } from 'lucide-react';
import type { User } from '@/types/user';

interface EditUserFormProps {
  user: User;
  currentUserRole: 'user' | 'admin' | 'super_admin';
}

// Format phone number for display: (XXX) XXX-XXXX
function formatPhoneDisplay(digits: string): string {
  const cleaned = digits.replace(/\D/g, '');
  const normalized = cleaned.length === 11 && cleaned.startsWith('1')
    ? cleaned.slice(1)
    : cleaned;

  if (normalized.length === 10) {
    return `(${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6)}`;
  }

  return normalized;
}

export function EditUserForm({ user, currentUserRole }: EditUserFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [fullName, setFullName] = useState(user.full_name || '');
  const [role, setRole] = useState<string>(user.role);
  const [phone, setPhone] = useState<string>(user.phone ? formatPhoneDisplay(user.phone) : '');
  const [isActive, setIsActive] = useState(user.is_active);
  const router = useRouter();

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted = formatPhoneDisplay(e.target.value);
    setPhone(formatted);
  };

  const handlePhonePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData('text');
    const formatted = formatPhoneDisplay(pastedText);
    setPhone(formatted);
  };

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setSuccess(false);

    const formData = new FormData();
    formData.set('fullName', fullName);
    formData.set('phone', phone);
    formData.set('role', role);
    formData.set('isActive', isActive.toString());

    try {
      await updateUser(user.id, formData);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-100 dark:border-slate-700 max-w-2xl">
      <div className="p-6 border-b border-gray-100 dark:border-slate-700">
        <div className="flex items-center gap-4 mb-2">
          <button
            type="button"
            onClick={() => router.push('/admin/users')}
            className="p-2 text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-gray-700 dark:text-white" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Edit User</h2>
          </div>
        </div>
        <p className="text-sm text-gray-500 dark:text-slate-400 ml-12">
          Update user information and permissions.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="p-6">
        {error && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
          </div>
        )}

        {success && (
          <div className="mb-6 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <p className="text-sm text-green-800 dark:text-green-300">User updated successfully!</p>
          </div>
        )}

        <div className="space-y-6">
          {/* Email (read-only) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">
              Email Address
            </label>
            <input
              type="email"
              value={user.email}
              disabled
              className="w-full px-4 py-2 border border-gray-200 dark:border-slate-600 rounded-lg bg-gray-50 dark:bg-slate-700 text-gray-500 dark:text-slate-400 cursor-not-allowed"
            />
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-2">
              Email cannot be changed. Create a new user if needed.
            </p>
          </div>

          {/* Full Name */}
          <div>
            <label
              htmlFor="fullName"
              className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2"
            >
              Full Name *
            </label>
            <input
              id="fullName"
              name="fullName"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="John Doe"
              required
              disabled={isSubmitting}
              className="w-full px-4 py-2 border border-gray-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white dark:bg-slate-700 text-gray-900 dark:text-white disabled:bg-gray-50 dark:disabled:bg-slate-600 disabled:text-gray-500"
            />
          </div>

          {/* Phone Number */}
          <div>
            <label
              htmlFor="phone"
              className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2"
            >
              <span className="flex items-center gap-1.5">
                <Phone className="h-4 w-4" />
                Phone Number
              </span>
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              placeholder="(555) 123-4567"
              value={phone}
              onChange={handlePhoneChange}
              onPaste={handlePhonePaste}
              disabled={isSubmitting}
              className="w-full px-4 py-2 border border-gray-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white dark:bg-slate-700 text-gray-900 dark:text-white disabled:bg-gray-50 dark:disabled:bg-slate-600 disabled:text-gray-500"
            />
          </div>

          {/* Role */}
          <div>
            <label
              htmlFor="role"
              className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2"
            >
              Role *
            </label>
            <select
              id="role"
              name="role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              required
              disabled={isSubmitting}
              className="w-full px-4 py-2 border border-gray-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white dark:bg-slate-700 text-gray-900 dark:text-white disabled:bg-gray-50 dark:disabled:bg-slate-600 disabled:text-gray-500"
            >
              <option value="user">User</option>
              <option value="admin">Administrator</option>
              {currentUserRole === 'super_admin' && (
                <option value="super_admin">Super Administrator</option>
              )}
            </select>
          </div>

          {/* Active Status */}
          <div className="flex items-start gap-3 p-4 bg-gray-50 dark:bg-slate-700 rounded-lg border border-gray-200 dark:border-slate-600">
            <input
              id="isActive"
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              disabled={isSubmitting}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            />
            <div className="flex-1">
              <label
                htmlFor="isActive"
                className="text-sm font-medium text-gray-700 dark:text-slate-200 cursor-pointer"
              >
                Account Active
              </label>
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                Inactive users cannot log in to the system.
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-4 pt-4">
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-2 text-white rounded-lg transition-colors font-medium disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-2"
              style={{ backgroundColor: isSubmitting ? undefined : '#5e3b8d' }}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  Save Changes
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => router.push('/admin/users')}
              disabled={isSubmitting}
              className="px-6 py-2 border border-gray-200 dark:border-slate-600 text-gray-700 dark:text-slate-300 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Back to Users
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
