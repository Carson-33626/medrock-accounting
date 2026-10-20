import type { NextConfig } from "next";

// The task system (Company Admin filing items) frames the sales-tax calculators, so those pages
// may be framed by it and nothing else; every other page stays unframeable.
const TASKS_ORIGIN = 'https://tasks.medrockpharmacy.com';

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload'
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()'
          }
        ],
      },
      {
        source: '/((?!sales-tax(?:/|$)).*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY'
          }
        ],
      },
      {
        source: '/sales-tax/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors 'self' ${TASKS_ORIGIN}`
          }
        ],
      },
    ];
  },
};

export default nextConfig;
