import { requireAuth } from '@/lib/auth';
import { DepositReview } from './components/DepositReview';

export const dynamic = 'force-dynamic';

// This is a top-level route deliberately NOT nested under /deposits, so it
// does not inherit that portal's middleware auth-only exemption (see
// middleware.ts AUTH_ONLY_EXACT and docs/superpowers/specs/
// 2026-07-20-deposit-review-page-design.md §3). Middleware already enforces
// the `accounting` app-slug entitlement for every other route; requireAuth()
// here is only for the user object, not for authorization.
//
// All dark-mode-aware chrome (background, headings) lives inside the client
// component below via useDarkMode() — this file stays a server component so
// requireAuth() can run here, and never uses Tailwind's `dark:` variant.
export default async function DepositReviewPage() {
  await requireAuth();

  return <DepositReview />;
}
