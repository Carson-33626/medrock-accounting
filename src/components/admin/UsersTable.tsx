'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Search, MoreVertical, ChevronUp, ChevronDown, Edit, KeyRound, Loader2, Check, X, Trash2, AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { User } from '@/types/user';

interface UsersTableProps {
  users: User[];
  currentUserRole: 'user' | 'admin' | 'super_admin';
}

type SortField = 'name' | 'email' | 'role' | 'created';
type SortDirection = 'asc' | 'desc';

export function UsersTable({ users, currentUserRole }: UsersTableProps) {
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('created');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [resetStatus, setResetStatus] = useState<{ userId: string; status: 'success' | 'error'; message: string } | null>(null);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenDropdownId(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Clear reset status after 3 seconds
  useEffect(() => {
    if (resetStatus) {
      const timer = setTimeout(() => setResetStatus(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [resetStatus]);

  const handleResetPassword = async (user: User) => {
    setResettingUserId(user.id);
    setOpenDropdownId(null);

    try {
      const response = await fetch('/api/send-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          redirectUrl: `${window.location.origin}/auth/reset-password/confirm`,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setResetStatus({
          userId: user.id,
          status: 'error',
          message: data.error || 'Failed to send reset email'
        });
        return;
      }

      setResetStatus({
        userId: user.id,
        status: 'success',
        message: data.message || `Reset email sent to ${user.email}`
      });
    } catch (err) {
      console.error('Password reset error:', err);
      setResetStatus({
        userId: user.id,
        status: 'error',
        message: 'Failed to send reset email. Please try again.'
      });
    } finally {
      setResettingUserId(null);
    }
  };

  const handleDeleteUser = async () => {
    if (!userToDelete) return;
    setIsDeleting(true);

    try {
      const response = await fetch('/api/delete-user', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userToDelete.id }),
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error || 'Failed to delete user');
        return;
      }

      window.location.reload();
    } catch (err) {
      console.error('Delete user error:', err);
      alert('Failed to delete user. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const filteredAndSortedUsers = useMemo(() => {
    let filtered = users.filter((user) => {
      const matchesSearch =
        user.full_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        user.email.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesRole = roleFilter === 'all' || user.role === roleFilter;

      return matchesSearch && matchesRole;
    });

    // Sort
    filtered.sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'name':
          comparison = (a.full_name || '').localeCompare(b.full_name || '');
          break;
        case 'email':
          comparison = a.email.localeCompare(b.email);
          break;
        case 'role':
          comparison = a.role.localeCompare(b.role);
          break;
        case 'created':
          comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          break;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [users, searchTerm, roleFilter, sortField, sortDirection]);

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-100 dark:border-slate-700 overflow-visible">
      {/* Header */}
      <div className="p-6 border-b border-gray-100 dark:border-slate-700">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
          Users ({filteredAndSortedUsers.length})
        </h2>
        <div className="flex flex-wrap gap-4 items-center">
          {/* Search */}
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <input
              type="text"
              placeholder="Search users..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-10 py-2 border border-gray-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                title="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Role Filter */}
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="px-4 py-2 border border-gray-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
          >
            <option value="all">All Roles</option>
            <option value="user">User</option>
            <option value="admin">Admin</option>
            <option value="super_admin">Super Admin</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-slate-700 border-b border-gray-100 dark:border-slate-600">
            <tr>
              <th
                onClick={() => handleSort('name')}
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-slate-300 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-600 select-none"
              >
                <div className="flex items-center gap-1">
                  User
                  {sortField === 'name' && (
                    sortDirection === 'asc' ?
                      <ChevronUp className="h-4 w-4" /> :
                      <ChevronDown className="h-4 w-4" />
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('role')}
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-slate-300 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-600 select-none"
              >
                <div className="flex items-center gap-1">
                  Role
                  {sortField === 'role' && (
                    sortDirection === 'asc' ?
                      <ChevronUp className="h-4 w-4" /> :
                      <ChevronDown className="h-4 w-4" />
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('created')}
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-slate-300 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-600 select-none"
              >
                <div className="flex items-center gap-1">
                  Created
                  {sortField === 'created' && (
                    sortDirection === 'asc' ?
                      <ChevronUp className="h-4 w-4" /> :
                      <ChevronDown className="h-4 w-4" />
                  )}
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-slate-300 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-slate-800 divide-y divide-gray-100 dark:divide-slate-700">
            {filteredAndSortedUsers.map((user) => (
              <tr key={user.id} className="hover:bg-gray-50 dark:hover:bg-slate-700">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white">
                      {user.full_name || 'No name'}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-slate-400">{user.email}</div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-medium ${
                      user.role === 'super_admin'
                        ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                        : user.role === 'admin'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                        : 'bg-gray-100 text-gray-700 dark:bg-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {user.role === 'super_admin' ? 'Super Admin' : user.role === 'admin' ? 'Admin' : 'User'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-slate-400">
                  {formatDistanceToNow(new Date(user.created_at), { addSuffix: true })}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="relative" ref={openDropdownId === user.id ? dropdownRef : null}>
                    {/* Status indicator */}
                    {resetStatus?.userId === user.id && (
                      <div className={`absolute right-8 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2 py-1 rounded text-xs whitespace-nowrap ${
                        resetStatus.status === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                      }`}>
                        {resetStatus.status === 'success' ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                        {resetStatus.message}
                      </div>
                    )}

                    {/* Loading indicator */}
                    {resettingUserId === user.id && (
                      <div className="absolute right-8 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-blue-50 text-blue-700">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Sending...
                      </div>
                    )}

                    <button
                      onClick={() => setOpenDropdownId(openDropdownId === user.id ? null : user.id)}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-white p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-600"
                      title="Actions"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>

                    {openDropdownId === user.id && (
                      <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-slate-700 rounded-lg shadow-lg border border-gray-200 dark:border-slate-600 py-1 z-50">
                        <button
                          onClick={() => {
                            setOpenDropdownId(null);
                            router.push(`/admin/users/${user.id}/edit`);
                          }}
                          className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-600 text-left"
                        >
                          <Edit className="h-4 w-4" />
                          Edit user
                        </button>
                        <button
                          onClick={() => handleResetPassword(user)}
                          disabled={resettingUserId === user.id}
                          className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-600 disabled:opacity-50"
                        >
                          <KeyRound className="h-4 w-4" />
                          Reset password
                        </button>
                        {(currentUserRole === 'super_admin' || (currentUserRole === 'admin' && user.role === 'user')) && (
                          <>
                            <div className="border-t border-gray-100 dark:border-slate-600 my-1" />
                            <button
                              onClick={() => {
                                setOpenDropdownId(null);
                                setUserToDelete(user);
                              }}
                              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete user
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredAndSortedUsers.length === 0 && (
          <div className="text-center py-12">
            <Search className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              No users found
            </h3>
            <p className="text-gray-500 dark:text-slate-400">
              {searchTerm || roleFilter !== 'all'
                ? 'Try adjusting your search or filters.'
                : 'No users have been created yet.'}
            </p>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {userToDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-md w-full mx-4 overflow-hidden">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-full">
                  <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Delete User</h3>
              </div>
              <p className="text-gray-600 dark:text-slate-300 mb-2">
                Are you sure you want to delete <strong>{userToDelete.full_name || userToDelete.email}</strong>?
              </p>
              <p className="text-sm text-gray-500 dark:text-slate-400">
                This action cannot be undone. The user will be permanently removed from the system.
              </p>
            </div>
            <div className="bg-gray-50 dark:bg-slate-700 px-6 py-4 flex justify-end gap-3">
              <button
                onClick={() => setUserToDelete(null)}
                disabled={isDeleting}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-slate-200 bg-white dark:bg-slate-600 border border-gray-300 dark:border-slate-500 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-500 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteUser}
                disabled={isDeleting}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" />
                    Delete User
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
