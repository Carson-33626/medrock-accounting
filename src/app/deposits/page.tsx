import Link from 'next/link';
import { requireAuth } from '@/lib/auth';
import { DepositUploader } from './components/DepositUploader';

export const dynamic = 'force-dynamic';

// AuthUser.location is a two-letter code; the API deals in full Drive folder
// names. The shared auth package's location type also allows 'FOCAS', which
// has no deposit folder — it isn't a key below, so the lookup falls through
// to `undefined` and the `?? ''` leaves the dropdown unselected instead of
// throwing.
const LOCATION_BY_CODE: Record<string, string> = {
  FL: 'Florida',
  TN: 'Tennessee',
  TX: 'Texas',
};

export default async function DepositsPage() {
  // Auth only — any logged-in MedRock employee can reach this page, no
  // accounting-specific role or entitlement required. requireAuth() throws a
  // redirect internally, so it must stay outside any try/catch here.
  const user = await requireAuth();
  const defaultLocation = user.location ? (LOCATION_BY_CODE[user.location] ?? '') : '';

  return (
    <>
      {/*
        The upload portal deliberately hides the accounting sidebar (see
        Sidebar.tsx) since it's reachable by staff without the accounting
        entitlement. That leaves accounting users who land here via the
        sidebar's "Deposit Upload" link with no way back — this link fixes
        that without touching DepositUploader.tsx (a client component owned
        by another in-flight change). It's safe for non-accounting staff too:
        following it to `/` just gets them bounced straight back here by
        middleware (see middleware.ts's `/` -> `/deposits` redirect on a 403).
      */}
      <div className="px-4 pt-4 md:px-8 md:pt-6">
        <Link
          href="/"
          className="text-sm text-slate-500 hover:text-slate-800 hover:underline"
        >
          ← Back to MedRock Accounting
        </Link>
      </div>
      <DepositUploader defaultLocation={defaultLocation} />
    </>
  );
}
