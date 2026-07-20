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

  return <DepositUploader defaultLocation={defaultLocation} />;
}
