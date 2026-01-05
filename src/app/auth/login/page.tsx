/**
 * Login page - redirects to centralized auth service
 *
 * This page exists as a fallback and for direct /auth/login visits.
 * The middleware should redirect unauthenticated users before they get here.
 */

'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';

function LoginRedirect() {
  const searchParams = useSearchParams();
  const redirectUrl = searchParams.get('redirect') || '/';

  useEffect(() => {
    // Redirect to centralized auth service
    const loginUrl = `${AUTH_SERVICE_URL}/login?redirect=${encodeURIComponent(
      window.location.origin + redirectUrl
    )}`;
    window.location.href = loginUrl;
  }, [redirectUrl]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-purple-50">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto mb-4"></div>
        <p className="text-gray-600">Redirecting to login...</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-purple-50">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
        </div>
      }
    >
      <LoginRedirect />
    </Suspense>
  );
}
