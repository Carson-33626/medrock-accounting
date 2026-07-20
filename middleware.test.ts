import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAuthOnlyRoute } from './middleware';

describe('isAuthOnlyRoute', () => {
  const exemptCases: Array<{ label: string; pathname: string }> = [
    { label: 'deposits page, exact', pathname: '/deposits' },
    { label: 'deposits page, trailing slash', pathname: '/deposits/' },
    { label: 'deposits api root', pathname: '/api/deposits' },
    { label: 'deposits api root, trailing slash', pathname: '/api/deposits/' },
    { label: 'deposits api upload', pathname: '/api/deposits/upload' },
    { label: 'deposits api remove', pathname: '/api/deposits/remove' },
    { label: 'deposits api locations', pathname: '/api/deposits/locations' },
  ];

  for (const { label, pathname } of exemptCases) {
    it(`treats "${pathname}" (${label}) as auth-only exempt`, () => {
      expect(isAuthOnlyRoute(pathname)).toBe(true);
    });
  }

  // A failure below means the exemption has widened: some route that should
  // still be behind the `accounting` app-slug entitlement check is instead
  // skipping it. That check is what keeps non-entitled staff out of payroll,
  // sales tax, and AP — treat any regression here as a security bug, not a
  // test-maintenance nuisance.
  const gatedCases: Array<{ label: string; pathname: string }> = [
    { label: 'nested under deposits page', pathname: '/deposits/anything' },
    { label: 'deposits review sub-path', pathname: '/deposits/review' },
    { label: 'lookalike sibling page', pathname: '/deposit-review' },
    { label: 'case-mismatched page', pathname: '/Deposits' },
    { label: 'api lookalike, no separator', pathname: '/api/deposits-secret' },
    { label: 'api lookalike, no separator (suffix)', pathname: '/api/depositsX' },
    { label: 'unrelated app page', pathname: '/payroll' },
    { label: 'unrelated app page', pathname: '/sales-tax' },
    { label: 'unrelated app page', pathname: '/inventory' },
    { label: 'app root', pathname: '/' },
    { label: 'unrelated api route', pathname: '/api/payroll/roster' },
    { label: 'encoded traversal attempt', pathname: '/deposits%2F..%2Fpayroll' },
  ];

  for (const { label, pathname } of gatedCases) {
    it(`treats "${pathname}" (${label}) as gated by the accounting entitlement`, () => {
      expect(isAuthOnlyRoute(pathname)).toBe(false);
    });
  }
});

// Invariant: every route under src/app/api/deposits/ is exempted by
// middleware from the `accounting` app-slug entitlement check (see
// AUTH_ONLY_PREFIXES above). That means middleware performs no real token
// validation for these routes — it only checks that the session cookie has
// the right shape. `requireAuth()` inside the route handler is the only
// thing that actually validates the session against the auth service, so it
// is load-bearing, not redundant. This test reads the directory from disk
// (rather than hardcoding a file list) so that a future route added under
// src/app/api/deposits/ without a requireAuth() call fails loudly here.
describe('src/app/api/deposits/* route handlers self-authenticate', () => {
  const depositsApiDir = path.join(__dirname, 'src', 'app', 'api', 'deposits');

  function findRouteFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const found: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...findRouteFiles(entryPath));
      } else if (entry.isFile() && entry.name === 'route.ts') {
        found.push(entryPath);
      }
    }

    return found;
  }

  const routeFiles = findRouteFiles(depositsApiDir);

  it('finds at least 3 route files (fails loudly if the scan matches nothing)', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const routeFile of routeFiles) {
    const relative = path.relative(depositsApiDir, routeFile);

    it(`${relative} calls requireAuth()`, () => {
      const contents = fs.readFileSync(routeFile, 'utf-8');
      expect(contents).toContain('requireAuth(');
    });
  }
});
