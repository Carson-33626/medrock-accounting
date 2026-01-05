'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useDarkMode } from '@/contexts/DarkModeContext';
import { useAuth } from '@/lib/use-auth';
import { authClient } from '@/lib/auth-client';

// Navigation items for AMY
const navigation = [
  { name: 'Coupons', href: '/', icon: CouponIcon },
  // Future pages can be added here
  // { name: 'Reports', href: '/reports', icon: ReportsIcon },
  // { name: 'Schedules', href: '/schedules', icon: ScheduleIcon },
];

export function Sidebar() {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { darkMode, toggleDarkMode } = useDarkMode();
  const { user, loading, logout } = useAuth();

  // Derive user display info
  const userEmail = user?.email || null;
  const userName = user?.first_name
    ? `${user.first_name}${user.last_name ? ' ' + user.last_name : ''}`
    : user?.email?.split('@')[0] || null;

  // Hide sidebar on auth pages
  if (pathname?.startsWith('/auth')) {
    return null;
  }

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setSidebarOpen(true)}
        className="fixed top-4 left-4 z-50 p-3 bg-slate-900 rounded-lg md:hidden shadow-lg active:bg-slate-700 transition-colors"
        aria-label="Open menu"
      >
        <MenuIcon className="w-6 h-6 text-white" />
      </button>

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <div
        className={`
          fixed md:sticky inset-y-0 left-0 z-50 md:top-0 md:h-screen
          flex flex-col w-64 bg-slate-900 text-white flex-shrink-0
          transform transition-transform duration-300 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          md:translate-x-0
        `}
      >
        {/* Close button - mobile only */}
        <button
          onClick={() => setSidebarOpen(false)}
          className="absolute top-4 right-4 p-2 text-slate-400 hover:text-white active:text-white transition-colors md:hidden"
          aria-label="Close menu"
        >
          <CloseIcon className="w-6 h-6" />
        </button>

        {/* Logo/Header */}
        <div className="p-4 border-b border-slate-700">
          <div className="logo-container rounded-lg p-3 mb-3">
            <Image
              src="/medrock-logo.png"
              alt="MedRock Pharmacy"
              width={180}
              height={58}
              className="mx-auto"
            />
          </div>
          <p className="text-sm font-medium text-center text-slate-300">AMY</p>
          <p className="text-xs text-center text-slate-500">Accounting Metrics & Yields</p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {navigation.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors min-h-[44px] ${
                  isActive
                    ? 'text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white active:bg-slate-700'
                }`}
                style={isActive ? { backgroundColor: '#5e3b8d' } : undefined}
              >
                <item.icon className="w-5 h-5" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        {/* Dark mode toggle */}
        <div className="px-4 pt-4 border-t border-slate-700">
          <button
            onClick={toggleDarkMode}
            className="w-full flex items-center justify-between px-4 py-3 rounded-lg text-slate-300 hover:bg-slate-800 hover:text-white active:bg-slate-700 transition-colors min-h-[44px]"
          >
            <span className="flex items-center gap-3">
              {darkMode ? (
                <SunIcon className="w-5 h-5 text-yellow-400" />
              ) : (
                <MoonIcon className="w-5 h-5" />
              )}
              {darkMode ? 'Light Mode' : 'Dark Mode'}
            </span>
          </button>
        </div>

        {/* User section */}
        <div className="p-4 border-t border-slate-700 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-2">
              <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full"></div>
            </div>
          ) : user ? (
            <>
              <div className="text-sm text-slate-400">
                <div className="flex items-center justify-between">
                  <span>Logged in as</span>
                  <button
                    onClick={() => authClient.profile()}
                    className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
                    title="Edit Profile"
                  >
                    <GearIcon className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-slate-200 font-medium truncate mt-0.5" title={userEmail || ''}>
                  {userName || userEmail || 'User'}
                </div>
              </div>
              <button
                onClick={() => logout()}
                className="flex items-center gap-2 w-full px-4 py-3 text-sm text-slate-300 hover:bg-slate-800 hover:text-white active:bg-slate-700 rounded-lg transition-colors min-h-[44px]"
              >
                <SignOutIcon className="w-4 h-4" />
                Sign Out
              </button>
            </>
          ) : (
            <p className="text-xs text-slate-500 text-center">
              Not logged in
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// Icons
function MenuIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function CouponIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
    </svg>
  );
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20">
      <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
    </svg>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
    </svg>
  );
}
