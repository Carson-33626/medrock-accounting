'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useDarkMode } from '@/contexts/DarkModeContext';
import { useAuth } from '@/lib/use-auth';
import { authClient } from '@/lib/auth-client';
import { AdminLink } from '@/components/AdminLink';
import { TAX_LOCATION_GROUPS, TAX_LEGACY_FILINGS } from '@/lib/sales-tax-filings';

// Navigation items for MedRock Accounting
// NOTE: Coupons and Marketer Profitability dashboards remain stashed in web/_archive
// (rebuild pending). Company Summary was rebuilt + modernized as Location Analytics.
// General section — open to any authenticated user.
const navigation = [
  { name: 'Drug Coding', href: '/', icon: PillIcon },
  { name: 'Inventory (FIFO)', href: '/inventory', icon: BoxIcon },
  { name: 'Nexus Exposure', href: '/nexus', icon: GlobeIcon },
  { name: 'Accounting Review Topics', href: '/cpa-review', icon: ClipboardIcon },
];

// Admin-only navigation. These pages enforce an admin role server-side (requireAdmin),
// so they're hidden from non-admins here to avoid the bounce-back-to-home trap.
// (User management lives in the central auth system.)
const adminNavigation = [
  { name: 'Location Analytics', href: '/location-analytics', icon: ChartIcon },
  { name: 'QuickBooks', href: '/admin/quickbooks', icon: QuickBooksIcon },
];

export function Sidebar() {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [salesTaxExpanded, setSalesTaxExpanded] = useState(false);
  // Each location (filing entity) is its own collapsible sub-menu; default all open.
  const [expandedLocations, setExpandedLocations] = useState<Set<string>>(
    () => new Set(TAX_LOCATION_GROUPS.map((g) => g.entity)),
  );
  const toggleLocation = (entity: string) =>
    setExpandedLocations((prev) => {
      const next = new Set(prev);
      if (next.has(entity)) next.delete(entity);
      else next.add(entity);
      return next;
    });

  // Auto-expand the Sales Tax group when on one of its pages.
  useEffect(() => {
    if (pathname?.startsWith('/sales-tax')) setSalesTaxExpanded(true);
  }, [pathname]);
  const { darkMode, toggleDarkMode } = useDarkMode();
  const { user, loading, logout } = useAuth();

  // Derive user display info
  const userEmail = user?.email || null;
  const userName = user?.first_name
    ? `${user.first_name}${user.last_name ? ' ' + user.last_name : ''}`
    : user?.email?.split('@')[0] || null;
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  // Hide sidebar on auth and public pages
  if (pathname?.startsWith('/auth') || pathname === '/terms' || pathname === '/privacy') {
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
          <p className="text-sm font-medium text-center text-slate-300">MedRock Accounting</p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          <p className="px-4 pt-1 pb-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">General</p>
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

          {/* Sales Tax — expandable group, one page per state */}
          {(() => {
            const groupActive = pathname?.startsWith('/sales-tax') ?? false;
            return (
              <div>
                <button
                  onClick={() => setSalesTaxExpanded((v) => !v)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors min-h-[44px] ${
                    groupActive && !salesTaxExpanded
                      ? 'text-white'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white active:bg-slate-700'
                  }`}
                  style={groupActive && !salesTaxExpanded ? { backgroundColor: '#5e3b8d' } : undefined}
                  aria-expanded={salesTaxExpanded}
                >
                  <ReceiptIcon className="w-5 h-5" />
                  <span className="flex-1 text-left">Sales Tax</span>
                  <ChevronIcon className={`w-4 h-4 transition-transform ${salesTaxExpanded ? 'rotate-90' : ''}`} />
                </button>
                {salesTaxExpanded && (
                  <div className="mt-1 ml-4 pl-3 border-l border-slate-700 space-y-1">
                    {/* Location sub-menus → states filed under each */}
                    {TAX_LOCATION_GROUPS.map((group) => {
                      const hasActive = group.filings.some((f) => pathname === `/sales-tax/${f.slug}`);
                      const open = expandedLocations.has(group.entity) || hasActive;
                      return (
                        <div key={group.entity}>
                          <button
                            onClick={() => toggleLocation(group.entity)}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider text-slate-400 hover:bg-slate-800 hover:text-white active:bg-slate-700 transition-colors"
                            aria-expanded={open}
                          >
                            <ChevronIcon className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
                            <span className="flex-1 text-left">{group.short}</span>
                          </button>
                          {open && (
                            <div className="ml-3 pl-3 border-l border-slate-800 space-y-1">
                              {group.filings.map((f) => {
                                const href = `/sales-tax/${f.slug}`;
                                const isActive = pathname === href;
                                return (
                                  <Link
                                    key={href}
                                    href={href}
                                    onClick={() => setSidebarOpen(false)}
                                    className={`block px-4 py-2 rounded-lg text-sm transition-colors min-h-[40px] flex items-center justify-between gap-2 ${
                                      isActive
                                        ? 'text-white'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-white active:bg-slate-700'
                                    }`}
                                    style={isActive ? { backgroundColor: '#5e3b8d' } : undefined}
                                  >
                                    <span>{f.stateAbbr} · {f.form.split(' ')[0]}</span>
                                    {!f.built && (
                                      <span className="text-[10px] font-medium text-slate-500 uppercase">soon</span>
                                    )}
                                  </Link>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Legacy registrations (filing until formally closed) */}
                    <div className="pt-2 mt-1 border-t border-slate-800">
                      <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                        Legacy
                      </p>
                      {TAX_LEGACY_FILINGS.map((f) => {
                        const href = `/sales-tax/${f.slug}`;
                        const isActive = pathname === href;
                        return (
                          <Link
                            key={href}
                            href={href}
                            onClick={() => setSidebarOpen(false)}
                            className={`block px-4 py-2 rounded-lg text-sm transition-colors min-h-[40px] flex items-center ${
                              isActive
                                ? 'text-white'
                                : 'text-slate-500 hover:bg-slate-800 hover:text-white active:bg-slate-700'
                            }`}
                            style={isActive ? { backgroundColor: '#5e3b8d' } : undefined}
                          >
                            {f.stateAbbr} · {f.stateName}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Admin Navigation */}
          {isAdmin && (
            <>
              <div className="pt-4 mt-4 border-t border-slate-700">
                <p className="px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Admin
                </p>
              </div>
              {adminNavigation.map((item) => {
                const isActive = pathname?.startsWith(item.href);
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
            </>
          )}
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

        {/* Terms and Privacy buttons */}
        <div className="px-4 pt-3">
          <div className="flex gap-2">
            <Link
              href="/terms"
              target="_blank"
              onClick={() => setSidebarOpen(false)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-slate-800 active:bg-slate-700 rounded-lg transition-colors"
            >
              <DocumentIcon className="w-3.5 h-3.5" />
              Terms
            </Link>
            <Link
              href="/privacy"
              target="_blank"
              onClick={() => setSidebarOpen(false)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-slate-800 active:bg-slate-700 rounded-lg transition-colors"
            >
              <ShieldIcon className="w-3.5 h-3.5" />
              Privacy
            </Link>
          </div>
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
                  <div className="flex items-center gap-1">
                    {/* Admin Dashboard Link - only shows for super_admin */}
                    <AdminLink
                      iconOnly
                      className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
                      label="Admin Dashboard"
                    />
                    <button
                      onClick={() => authClient.profile()}
                      className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
                      title="Edit Profile"
                    >
                      <GearIcon className="w-4 h-4" />
                    </button>
                  </div>
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

function BoxIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}

function PillIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.5l8-8a4.95 4.95 0 117 7l-8 8a4.95 4.95 0 11-7-7z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l7 7" />
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

function ReceiptIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 7h6m-6 4h6m-6 4h4M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3l-2 1-2-1-2 1-2-1-2 1-2-1z" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

function ChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v18h18M9 17V9m4 8V5m4 12v-6" />
    </svg>
  );
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18M12 3a15 15 0 000 18" />
    </svg>
  );
}

function ClipboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  );
}

function QuickBooksIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>
  );
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  );
}

