'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createUser } from '@/lib/user-actions';
import { UserPlus, Loader2, Eye, EyeOff, RefreshCw, Copy, Check, Phone, ArrowLeft, Building2 } from 'lucide-react';
import { DEPARTMENTS } from '@/types/user';

interface CreateUserFormProps {
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

// Generate a random temporary password
function generateTempPassword(): string {
  const length = 12;
  const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lowercase = 'abcdefghjkmnpqrstuvwxyz';
  const numbers = '23456789';
  const special = '!@#$%&*';

  let password = '';
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];
  password += special[Math.floor(Math.random() * special.length)];

  const allChars = uppercase + lowercase + numbers + special;
  for (let i = password.length; i < length; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }

  return password.split('').sort(() => Math.random() - 0.5).join('');
}

export function CreateUserForm({ currentUserRole }: CreateUserFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [phone, setPhone] = useState<string>('');
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
  const router = useRouter();

  const toggleDepartment = (dept: string) => {
    setSelectedDepartments(prev =>
      prev.includes(dept)
        ? prev.filter(d => d !== dept)
        : [...prev, dept]
    );
  };

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

  const handleGeneratePassword = () => {
    const newPassword = generateTempPassword();
    setPassword(newPassword);
    setShowPassword(true);
  };

  const handleCopyPassword = async () => {
    if (password) {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const formData = new FormData(e.currentTarget);
    formData.set('departments', JSON.stringify(selectedDepartments));

    try {
      await createUser(formData);
      router.push('/admin/users');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
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
            onClick={() => router.back()}
            className="p-2 text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-gray-700 dark:text-white" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Create New User</h2>
          </div>
        </div>
        <p className="text-sm text-gray-500 dark:text-slate-400 ml-12">
          Create a new user account with immediate access to the system.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="p-6">
        {error && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
          </div>
        )}

        <div className="space-y-6">
          {/* Email and Full Name */}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2"
              >
                Email Address *
              </label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="user@company.com"
                required
                disabled={isSubmitting}
                className="w-full px-4 py-2 border border-gray-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white dark:bg-slate-700 text-gray-900 dark:text-white disabled:bg-gray-50 dark:disabled:bg-slate-600 disabled:text-gray-500"
              />
            </div>

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
                placeholder="John Doe"
                required
                disabled={isSubmitting}
                className="w-full px-4 py-2 border border-gray-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white dark:bg-slate-700 text-gray-900 dark:text-white disabled:bg-gray-50 dark:disabled:bg-slate-600 disabled:text-gray-500"
              />
            </div>
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
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-2">
              Optional - used for SMS login verification
            </p>
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
              <option value="">Select user role</option>
              <option value="user">User</option>
              <option value="admin">Administrator</option>
              {currentUserRole === 'super_admin' && (
                <option value="super_admin">Super Administrator</option>
              )}
            </select>
          </div>

          {/* Departments */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">
              <span className="flex items-center gap-1.5">
                <Building2 className="h-4 w-4" />
                Departments
              </span>
            </label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {DEPARTMENTS.map((dept) => (
                <label
                  key={dept}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                    selectedDepartments.includes(dept)
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300'
                      : 'border-gray-200 dark:border-slate-600 hover:border-gray-300 dark:hover:border-slate-500 text-gray-700 dark:text-slate-300'
                  } ${isSubmitting ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedDepartments.includes(dept)}
                    onChange={() => toggleDepartment(dept)}
                    disabled={isSubmitting}
                    className="sr-only"
                  />
                  <div className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                    selectedDepartments.includes(dept)
                      ? 'border-purple-500 bg-purple-500'
                      : 'border-gray-300 dark:border-slate-500'
                  }`}>
                    {selectedDepartments.includes(dept) && (
                      <Check className="h-3 w-3 text-white" />
                    )}
                  </div>
                  <span className="text-sm">{dept}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-2">
              Select the departments this user belongs to
            </p>
          </div>

          {/* Password */}
          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2"
            >
              Temporary Password *
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Create or generate a temporary password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isSubmitting}
                  minLength={6}
                  className="w-full px-4 py-2 pr-20 border border-gray-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white dark:bg-slate-700 text-gray-900 dark:text-white disabled:bg-gray-50 dark:disabled:bg-slate-600 disabled:text-gray-500"
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                  {password && (
                    <button
                      type="button"
                      onClick={handleCopyPassword}
                      className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-white transition-colors"
                      title="Copy password"
                    >
                      {copied ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-white transition-colors"
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={handleGeneratePassword}
                disabled={isSubmitting}
                className="px-3 py-2 bg-gray-100 dark:bg-slate-600 text-gray-700 dark:text-white rounded-lg hover:bg-gray-200 dark:hover:bg-slate-500 transition-colors flex items-center gap-1.5 text-sm font-medium disabled:opacity-50"
                title="Generate random password"
              >
                <RefreshCw className="h-4 w-4" />
                Generate
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-2">
              Click &quot;Generate&quot; to create a secure temporary password. The user will be required to change this password after their first login.
            </p>
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
                  Creating User...
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4" />
                  Create User
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              disabled={isSubmitting}
              className="px-6 py-2 border border-gray-200 dark:border-slate-600 text-gray-700 dark:text-slate-300 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
